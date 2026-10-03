/**
 * Background worker — runs independently of the web app and keeps alerts working when no browser is open.
 *
 *   Market data ──poll──▶ Alert engine ──▶ AlertEvent + TelegramDelivery (outbox) ──▶ queue ──▶ Telegram API
 *
 * Modes:
 *  - REDIS_URL set: BullMQ job scheduler drives price polling (one poller across any number of worker
 *    replicas) and a BullMQ worker sends Telegram messages with rate limiting and retries.
 *  - No Redis: an in-process poll loop + database outbox sweep (good for development / single node).
 * In both modes a periodic outbox sweep recovers anything left QUEUED/RETRYING or stuck SENDING (crash, restart, Redis outage).
 *
 * Start with: npm run worker
 */
import dotenv from "dotenv";
import os from "node:os";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { db, disconnectDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkEnv } from "@/lib/env";
import { purgeExpiredSessions } from "@/lib/services/auth";
import { processDelivery, sweepDueDeliveries } from "@/lib/notifications/delivery";
import { pollOnce } from "@/lib/services/prices";
import { pruneCandles } from "@/lib/market/service";
import { closeQueues, enqueueDeliveries, ENGINE_QUEUE, TELEGRAM_QUEUE } from "@/lib/queue";
import { closeRedis } from "@/lib/queue/redis";

// Match Next.js env precedence so the worker sees the same configuration as the web app
// (.env.local overrides .env; real process env always wins). `dotenv/config` alone would only
// read .env and silently diverge — e.g. it would send to the real Telegram API in development.
for (const file of [".env.local", ".env"]) dotenv.config({ path: file, override: false, quiet: true });

const POLL_MS = Math.max(500, Number(process.env.PRICE_POLL_INTERVAL_MS ?? 5000));
const workerId = `${os.hostname()}:${process.pid}`;
const startedAt = new Date();
const timers: NodeJS.Timeout[] = [];
const closers: (() => Promise<unknown>)[] = [];
let shuttingDown = false;

function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running || shuttingDown) return; // never overlap runs
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error(`${name} failed`, { err });
    } finally {
      running = false;
    }
  };
  timers.push(setInterval(tick, ms));
  void tick();
}

async function heartbeat() {
  const mode = process.env.REDIS_URL ? "bullmq" : "outbox";
  await db.workerHeartbeat.upsert({
    where: { id: workerId },
    create: { id: workerId, startedAt, lastSeenAt: new Date(), info: { mode, pollMs: POLL_MS } },
    update: { lastSeenAt: new Date() },
  });
  await db.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
}

async function runPoll() {
  const { summary, deliveryIds } = await pollOnce();
  if (deliveryIds.length) logger.info("Poll cycle produced notifications", { count: deliveryIds.length, summary });
  else logger.debug("Poll cycle", { summary });
  // Without Redis the deliveries are sent right away by this process.
  if (!process.env.REDIS_URL) for (const id of deliveryIds) await processDelivery(id);
}

async function startWithRedis(url: string) {
  const conn = () => new Redis(url, { maxRetriesPerRequest: null });

  const telegramWorker = new Worker(
    TELEGRAM_QUEUE,
    async (job) => {
      const id = job.data.deliveryId as string;
      const outcome = await processDelivery(id);
      if (outcome.status === "retry") await enqueueDeliveries([id], Math.max(0, outcome.retryAt.getTime() - Date.now()));
      return outcome;
    },
    {
      connection: conn(),
      concurrency: 5,
      // Telegram allows ~30 msgs/sec per bot; stay comfortably under it globally.
      limiter: { max: 25, duration: 1000 },
    },
  );
  telegramWorker.on("failed", (job, err) => logger.error("Telegram job failed", { jobId: job?.id, err: err.message }));

  const engineQueue = new Queue(ENGINE_QUEUE, { connection: conn() });
  await engineQueue.upsertJobScheduler(
    "price-poll",
    { every: POLL_MS },
    { name: "poll", opts: { removeOnComplete: 100, removeOnFail: 100 } },
  );
  const engineWorker = new Worker(ENGINE_QUEUE, async () => runPoll(), { connection: conn(), concurrency: 1 });
  engineWorker.on("failed", (job, err) => logger.error("Poll job failed", { jobId: job?.id, err: err.message }));

  closers.push(
    () => telegramWorker.close(),
    () => engineWorker.close(),
    () => engineQueue.close(),
  );

  // Outbox recovery: anything due for >10s that the queue didn't handle.
  every(15_000, "outbox sweep", () => sweepDueDeliveries(100, 10_000));
  logger.info("Worker started (BullMQ mode)", { workerId, pollMs: POLL_MS });
}

function startWithoutRedis() {
  every(POLL_MS, "price poll", runPoll);
  every(1_000, "outbox sweep", () => sweepDueDeliveries(50));
  logger.info("Worker started (database outbox mode — set REDIS_URL to use BullMQ)", { workerId, pollMs: POLL_MS });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Worker shutting down", { signal });
  timers.forEach(clearInterval);
  await Promise.allSettled(closers.map((c) => c()));
  await closeQueues();
  await closeRedis();
  await db.workerHeartbeat.delete({ where: { id: workerId } }).catch(() => undefined);
  await disconnectDb();
  process.exit(0);
}

async function main() {
  const { errors, warnings } = checkEnv();
  for (const w of warnings) logger.warn(`Config: ${w}`);
  if (errors.length) {
    for (const e of errors) logger.error(`Config: ${e}`);
    throw new Error("Invalid configuration; see the log above.");
  }
  await db.$queryRaw`SELECT 1`; // fail fast if the database is unreachable
  every(10_000, "heartbeat", heartbeat);
  every(60 * 60_000, "session purge", async () => {
    const n = await purgeExpiredSessions();
    if (n) logger.info("Purged expired sessions", { count: n });
  });
  every(60 * 60_000, "candle prune", async () => {
    const n = await pruneCandles();
    if (n) logger.info("Pruned old candles", { count: n });
  });
  const url = process.env.REDIS_URL;
  if (url) await startWithRedis(url);
  else startWithoutRedis();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => logger.error("Unhandled rejection in worker", { err }));

main().catch((err) => {
  logger.error("Worker failed to start", { err });
  process.exit(1);
});
