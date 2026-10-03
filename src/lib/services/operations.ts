import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkAll } from "@/lib/health";
import { listProviders } from "@/lib/market-data/registry";
import { retryFailedDeliveries } from "@/lib/notifications/delivery";
import { enqueueDeliveries } from "@/lib/queue";
import { resetRateLimits } from "@/lib/rate-limit";
import { resumeAlert } from "@/lib/services/alerts";
import { audit, listAudit } from "@/lib/services/audit";
import { AppError } from "@/lib/errors";

/**
 * System status and operations (M21/M22): health, provider health, queue visibility, and the operator actions
 * (pause all / resume all, reconnect market data, retry failed notifications), each written to the audit log.
 */

export async function systemStatus(userId: string) {
  const now = Date.now();
  const [health, providerHealth, deliveryCounts, oldestQueued, backtests, auditLog, pausedByBulk, live] = await Promise.all([
    checkAll(),
    db.providerHealth.findMany(),
    db.telegramDelivery.groupBy({ by: ["status"], where: { userId }, _count: true }),
    db.telegramDelivery.findFirst({
      where: { userId, status: { in: ["QUEUED", "RETRYING", "SENDING"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, status: true, attempts: true, nextAttemptAt: true, error: true },
    }),
    db.backtest.groupBy({ by: ["status"], where: { userId }, _count: true }),
    listAudit(userId, 50),
    db.alert.count({ where: { userId, pausedByBulk: true, status: "PAUSED" } }),
    db.alert.count({ where: { userId, status: { in: ["ACTIVE", "COOLDOWN"] } } }),
  ]);
  const ph = new Map(providerHealth.map((p) => [p.provider, p]));
  return {
    health,
    providers: listProviders().map((p) => {
      const h = ph.get(p.key);
      return {
        key: p.key,
        label: p.label,
        configured: p.configured,
        synthetic: !!p.capabilities.synthetic,
        realtime: p.capabilities.realtime,
        candleTimeframes: p.capabilities.candleTimeframes,
        volume: p.capabilities.volume,
        lastSuccessAt: h?.lastSuccessAt ?? null,
        lastErrorAt: h?.lastErrorAt ?? null,
        lastError: h?.lastError ?? null,
        consecutiveFailures: h?.consecutiveFailures ?? 0,
      };
    }),
    queues: {
      deliveries: Object.fromEntries(deliveryCounts.map((d) => [d.status, d._count])),
      oldestPending: oldestQueued ? { ...oldestQueued, ageSec: Math.round((now - oldestQueued.createdAt.getTime()) / 1000) } : null,
      backtests: Object.fromEntries(backtests.map((b) => [b.status, b._count])),
      mode: process.env.REDIS_URL ? "bullmq" : "database outbox",
    },
    alerts: { live, pausedByBulk },
    audit: auditLog,
  };
}
export type SystemStatus = Awaited<ReturnType<typeof systemStatus>>;

/** Pauses every live alert, remembering which ones (pausedByBulk) so "resume all" restores exactly those. */
export async function pauseAll(userId: string, ip?: string | null) {
  const r = await db.alert.updateMany({
    where: { userId, status: { in: ["ACTIVE", "COOLDOWN"] } },
    data: { status: "PAUSED", pausedByBulk: true, version: { increment: 1 } },
  });
  await audit(userId, "alerts.pause_all", null, { count: r.count }, ip);
  logger.warn("All alerts paused", { userId, count: r.count });
  return { paused: r.count };
}

/** Resumes the alerts paused by "pause all" (each through the normal activation checks). */
export async function resumeAll(userId: string, ip?: string | null) {
  const rows = await db.alert.findMany({ where: { userId, pausedByBulk: true, status: "PAUSED" }, select: { id: true, name: true } });
  const failed: { name: string; error: string }[] = [];
  let resumed = 0;
  for (const a of rows) {
    try {
      await resumeAlert(userId, a.id);
      resumed++;
    } catch (err) {
      failed.push({ name: a.name, error: err instanceof AppError ? err.message : "Failed" });
    }
  }
  // Clear the marker for everything we handled (failures stay paused, as normal paused alerts).
  await db.alert.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { pausedByBulk: false } });
  await audit(userId, "alerts.resume_all", null, { resumed, failed: failed.length }, ip);
  return { resumed, failed };
}

/**
 * "Reconnect market data": clears provider failure counters and request budgets so the next cycle retries
 * every provider immediately, then runs one poll cycle now (in this process).
 */
export async function reconnectMarketData(userId: string, ip?: string | null) {
  await db.providerHealth.updateMany({ data: { consecutiveFailures: 0 } });
  resetRateLimits();
  let summary: unknown = null;
  try {
    const { pollOnce } = await import("@/lib/services/prices");
    const r = await pollOnce();
    summary = r.summary;
    if (r.deliveryIds.length) await enqueueDeliveries(r.deliveryIds);
  } catch (err) {
    summary = { error: (err as Error).message };
  }
  await audit(userId, "market.reconnect", null, { summary: summary as Record<string, unknown> }, ip);
  return { summary };
}

export async function retryFailedNotifications(userId: string, ip?: string | null) {
  const n = await retryFailedDeliveries(userId);
  await audit(userId, "notifications.retry_failed", null, { count: n }, ip);
  return { requeued: n };
}
