import { Queue } from "bullmq";
import { getRedis } from "@/lib/queue/redis";
import { logger } from "@/lib/logger";

/**
 * Notification queue.
 *  - With REDIS_URL: BullMQ queue "telegram" consumed by the worker (src/worker).
 *  - Without Redis: deliveries stay PENDING in the database (transactional outbox) and the worker's
 *    sweep picks them up within ~1s. Callers that need low latency in that mode may process inline.
 *
 * Either way the TelegramDelivery row is the source of truth, so nothing is lost if Redis or the worker restarts.
 */
export const TELEGRAM_QUEUE = "telegram";
export const ENGINE_QUEUE = "engine";

const g = globalThis as unknown as { telegramQueue?: Queue | null };

export function getTelegramQueue(): Queue | null {
  if (g.telegramQueue !== undefined) return g.telegramQueue;
  const connection = getRedis();
  g.telegramQueue = connection ? new Queue(TELEGRAM_QUEUE, { connection }) : null;
  return g.telegramQueue;
}

export function queueEnabled() {
  return !!process.env.REDIS_URL;
}

/** Enqueue deliveries. Returns false if no queue is configured (caller may process inline). */
export async function enqueueDeliveries(ids: string[], delayMs = 0): Promise<boolean> {
  if (!ids.length) return true;
  const queue = getTelegramQueue();
  if (!queue) return false;
  try {
    await queue.addBulk(
      ids.map((id) => ({
        name: "send",
        data: { deliveryId: id },
        opts: {
          // jobId dedupes duplicate enqueues of the same delivery (the DB claim makes sends idempotent anyway)
          jobId: delayMs ? `${id}-retry-${Date.now() + delayMs}` : id,
          delay: delayMs,
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      })),
    );
    return true;
  } catch (err) {
    // Redis down: the outbox sweep will still deliver these.
    logger.warn("Failed to enqueue deliveries; falling back to outbox sweep", { err: String(err) });
    return false;
  }
}

export async function closeQueues() {
  await g.telegramQueue?.close().catch(() => undefined);
  g.telegramQueue = undefined;
}
