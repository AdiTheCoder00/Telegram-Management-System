import { Redis } from "ioredis";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/market-data/registry";

/**
 * Health checks with honest states. A component is only reported healthy when it was actually verified;
 * mock/simulated data is never reported as live.
 */
export type ComponentStatus = "CONNECTED" | "DISCONNECTED" | "NOT_CONFIGURED" | "DEGRADED" | "STALE" | "RUNNING" | "STOPPED" | "ERROR";

export interface ComponentHealth {
  status: ComponentStatus;
  checkedAt: string;
  latencyMs?: number;
  detail?: string;
  [key: string]: unknown;
}

const now = () => new Date().toISOString();

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t) };
}

export async function checkDatabase(): Promise<ComponentHealth> {
  try {
    const { ms } = await timed(() => db.$queryRaw`SELECT 1`);
    return { status: "CONNECTED", checkedAt: now(), latencyMs: ms };
  } catch {
    return { status: "DISCONNECTED", checkedAt: now(), detail: "PostgreSQL is unreachable." };
  }
}

export async function checkRedis(): Promise<ComponentHealth> {
  const url = process.env.REDIS_URL;
  if (!url) {
    return {
      status: "NOT_CONFIGURED",
      checkedAt: now(),
      detail: "REDIS_URL is not set. Queues run in database-outbox mode.",
    };
  }
  // Dedicated short-lived client: the shared BullMQ connection retries forever and would hang a health probe.
  const client = new Redis(url, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on("error", () => undefined);
  try {
    const { value, ms } = await timed(async () => {
      await client.connect();
      return client.ping();
    });
    return { status: value === "PONG" ? "CONNECTED" : "ERROR", checkedAt: now(), latencyMs: ms };
  } catch {
    return { status: "DISCONNECTED", checkedAt: now(), detail: "Redis is unreachable." };
  } finally {
    client.disconnect();
  }
}

/** Maximum age of a polled price before it counts as stale (default: 3 poll intervals, at least 15 s). */
export function maxQuoteAgeMs() {
  const configured = Number(process.env.MARKET_DATA_MAX_AGE_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return Math.max(15_000, 3 * Number(process.env.PRICE_POLL_INTERVAL_MS ?? 5000));
}

type FeedState = "FRESH" | "STALE" | "NO_DATA" | "SIMULATED" | "PUSH";

export async function checkMarketData(): Promise<ComponentHealth> {
  try {
    const feeds = await db.alert.groupBy({ by: ["dataProvider", "symbol"], where: { status: "ACTIVE" } });
    if (!feeds.length) return { status: "NOT_CONFIGURED", checkedAt: now(), detail: "No active alerts need market data.", feeds: [] };

    const quotes = await db.quote.findMany({
      where: { OR: feeds.map((f) => ({ provider: f.dataProvider, symbol: f.symbol })) },
      select: { provider: true, symbol: true, updatedAt: true },
    });
    const latest = new Map<string, Date>();
    for (const q of quotes) {
      const k = `${q.provider}:${q.symbol}`;
      if (!latest.has(k) || latest.get(k)! < q.updatedAt) latest.set(k, q.updatedAt);
    }

    const maxAge = maxQuoteAgeMs();
    const result = feeds.map((f) => {
      const provider = getProvider(f.dataProvider);
      const at = latest.get(`${f.dataProvider}:${f.symbol}`);
      const ageMs = at ? Date.now() - at.getTime() : null;
      let state: FeedState;
      if (provider?.pushOnly)
        state = "PUSH"; // freshness depends on the external sender; age is reported
      else if (f.dataProvider === "simulated") state = "SIMULATED";
      else if (ageMs === null) state = "NO_DATA";
      else state = ageMs <= maxAge ? "FRESH" : "STALE";
      return { provider: f.dataProvider, symbol: f.symbol, state, ageMs, lastUpdate: at?.toISOString() ?? null };
    });

    const polled = result.filter((r) => r.state === "FRESH" || r.state === "STALE" || r.state === "NO_DATA");
    let status: ComponentStatus;
    if (polled.some((r) => r.state !== "FRESH")) status = polled.every((r) => r.state !== "FRESH") ? "STALE" : "DEGRADED";
    else if (result.some((r) => r.state === "SIMULATED"))
      status = "DEGRADED"; // running on mock data, not live
    else status = "CONNECTED";

    return {
      status,
      checkedAt: now(),
      maxAgeMs: maxAge,
      detail:
        status === "DEGRADED" && !polled.some((r) => r.state !== "FRESH")
          ? "Some feeds use the simulated (mock) provider — not live market data."
          : undefined,
      feeds: result,
    };
  } catch {
    return { status: "ERROR", checkedAt: now(), detail: "Could not read market-data state from the database." };
  }
}

export const WORKER_HEARTBEAT_TIMEOUT_MS = 30_000;

export async function checkWorkers(): Promise<ComponentHealth> {
  try {
    const beats = await db.workerHeartbeat.findMany({ orderBy: { lastSeenAt: "desc" }, take: 10 });
    const alive = beats.filter((b) => Date.now() - b.lastSeenAt.getTime() < WORKER_HEARTBEAT_TIMEOUT_MS);
    return {
      status: alive.length ? "RUNNING" : "STOPPED",
      checkedAt: now(),
      detail: alive.length
        ? undefined
        : "No worker heartbeat in the last 30 s. Alerts are not being evaluated. Start it with `npm run worker`.",
      workers: beats.map((b) => ({
        id: b.id,
        alive: Date.now() - b.lastSeenAt.getTime() < WORKER_HEARTBEAT_TIMEOUT_MS,
        startedAt: b.startedAt.toISOString(),
        lastSeenAt: b.lastSeenAt.toISOString(),
        info: b.info,
      })),
    };
  } catch {
    return { status: "ERROR", checkedAt: now(), detail: "Could not read worker heartbeats." };
  }
}

export async function checkAll() {
  const [database, redis, marketData, workers] = await Promise.all([checkDatabase(), checkRedis(), checkMarketData(), checkWorkers()]);
  const down = database.status !== "CONNECTED";
  const degraded =
    redis.status === "DISCONNECTED" || workers.status !== "RUNNING" || ["STALE", "DEGRADED", "ERROR"].includes(marketData.status);
  return {
    status: down ? "DOWN" : degraded ? "DEGRADED" : "OK",
    checks: { database, redis, marketData, workers },
  } as const;
}
