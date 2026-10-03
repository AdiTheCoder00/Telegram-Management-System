import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { TelegramProvider, type NotificationProvider } from "@/lib/notifications/provider";
import type { DeliveryStatus } from "@/generated/prisma/client";

/**
 * Notification pipeline (M20). Consumes delivery rows created by the alert engine (it never decides whether
 * an alert triggered) and drives each through:
 *
 *   QUEUED ──claim──▶ SENDING ──▶ SENT
 *                          ├──▶ RETRYING  (transient: network / 5xx / 429; exponential backoff) ──▶ SENDING …
 *                          ├──▶ FAILED    (permanent: bad token, unknown chat, bot disabled/deleted)
 *                          └──▶ DEAD_LETTER (transient errors exhausted MAX_ATTEMPTS)
 *
 * Claims are conditional updates, so a delivery is sent by at most one worker at a time, however many
 * queues, sweeps and retries touch it. A failed notification never erases its trigger (the AlertEvent and
 * its evidence are committed before delivery starts).
 *
 * Delivery guarantee: at-least-once. If a process dies after Telegram accepted a message but before the row
 * was marked SENT, the expired SENDING lock makes it eligible again — a rare duplicate is preferred over a
 * silently lost alert. Documented in docs/reliability.md.
 */
export const MAX_ATTEMPTS = Math.max(1, Number(process.env.TELEGRAM_MAX_RETRIES ?? 6));
const LOCK_MS = 60_000;

export type ProcessOutcome =
  | { status: "sent"; telegramMessageId: string }
  | { status: "retry"; retryAt: Date; error: string }
  | { status: "failed"; error: string }
  | { status: "dead_letter"; error: string }
  | { status: "skipped" }; // not due, already done, or being sent by another worker

/** Statuses a worker may pick up (SENDING only once its lock has expired — i.e. after a crash). */
export const DUE_STATUSES: DeliveryStatus[] = ["QUEUED", "RETRYING"];

function backoffMs(attempt: number) {
  return Math.min(5 * 60_000, 2_000 * 2 ** (attempt - 1)); // 2s, 4s, 8s … capped at 5min
}

async function syncEventStatus(eventId: string | null, status: DeliveryStatus) {
  if (eventId) await db.alertEvent.update({ where: { id: eventId }, data: { status } }).catch(() => undefined);
}

/** Builds the provider for a delivery's channel (only Telegram today). */
export type ProviderFactory = (bot: { id: string; encryptedToken: string }, chatId: string) => NotificationProvider;
const defaultFactory: ProviderFactory = (bot, chatId) =>
  new TelegramProvider({ botId: bot.id, encryptedToken: bot.encryptedToken, chatId });

export async function processDelivery(id: string, providerFor: ProviderFactory = defaultFactory): Promise<ProcessOutcome> {
  const now = new Date();
  const claimed = await db.telegramDelivery.updateMany({
    where: {
      id,
      OR: [
        { status: { in: DUE_STATUSES }, nextAttemptAt: { lte: new Date(now.getTime() + 2000) } }, // slack for clock skew
        { status: "SENDING", lockedUntil: { lt: now } }, // crashed mid-send → recover
      ],
    },
    data: { status: "SENDING", lockedUntil: new Date(now.getTime() + LOCK_MS), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return { status: "skipped" };

  const d = await db.telegramDelivery.findUniqueOrThrow({ where: { id }, include: { bot: true } });
  await syncEventStatus(d.alertEventId, "SENDING");

  const finish = async (status: "FAILED" | "DEAD_LETTER", error: string, errorDetail?: string): Promise<ProcessOutcome> => {
    await db.telegramDelivery.update({
      where: { id },
      data: { status, error, errorDetail: errorDetail?.slice(0, 1000), lockedUntil: null },
    });
    await syncEventStatus(d.alertEventId, status);
    if (d.alertId && !d.isTest) await db.alert.update({ where: { id: d.alertId }, data: { lastError: error } }).catch(() => undefined);
    return status === "FAILED" ? { status: "failed", error } : { status: "dead_letter", error };
  };

  if (!d.bot) return finish("FAILED", "The Telegram bot for this alert was deleted. Assign another bot to the alert.", "bot_deleted");
  // Disabled bots send nothing. The trigger itself stays recorded; only this delivery fails.
  if (!d.bot.enabled)
    return finish(
      "FAILED",
      "The Telegram bot is disabled, so this notification was not sent. Enable the bot to resume notifications.",
      "bot_disabled",
    );

  let result;
  try {
    result = await providerFor(d.bot, d.chatId).send({ deliveryId: id, text: d.message, parseMode: d.parseMode, isTest: d.isTest });
  } catch (err) {
    // A provider bug must not crash the worker or strand the row in SENDING.
    logger.error("Notification provider threw", { deliveryId: id, err });
    result = {
      ok: false as const,
      retryable: true,
      userMessage: "Sending failed unexpectedly; it will be retried.",
      detail: String(err),
      destinationBroken: false,
    };
  }

  if (result.ok) {
    await db.telegramDelivery.update({
      where: { id },
      data: {
        status: "SENT",
        telegramMessageId: result.providerMessageId,
        sentAt: new Date(),
        lockedUntil: null,
        error: result.notes.length ? result.notes.join(" ") : null,
        ...(result.destinationChanged ? { chatId: result.destinationChanged } : {}),
      },
    });
    await syncEventStatus(d.alertEventId, "SENT");
    await db.telegramBot
      .update({ where: { id: d.bot.id }, data: { status: "CONNECTED", lastError: null, lastCheckedAt: new Date() } })
      .catch(() => undefined);
    if (d.alertId && !d.isTest) await db.alert.update({ where: { id: d.alertId }, data: { lastError: null } }).catch(() => undefined);
    logger.info("Notification sent", { deliveryId: id, messageId: result.providerMessageId });
    return { status: "sent", telegramMessageId: result.providerMessageId };
  }

  if (result.retryable) {
    if (d.attempts >= MAX_ATTEMPTS) {
      logger.error("Notification dead-lettered (retries exhausted)", { deliveryId: id, attempts: d.attempts, detail: result.detail });
      return finish("DEAD_LETTER", `Gave up after ${d.attempts} attempts: ${result.userMessage}`, result.detail);
    }
    const delay = result.retryAfterSec ? result.retryAfterSec * 1000 : backoffMs(d.attempts);
    const retryAt = new Date(Date.now() + delay);
    await db.telegramDelivery.update({
      where: { id },
      data: { status: "RETRYING", nextAttemptAt: retryAt, lockedUntil: null, error: result.userMessage, errorDetail: result.detail },
    });
    await syncEventStatus(d.alertEventId, "RETRYING");
    logger.warn("Notification will be retried", { deliveryId: id, attempts: d.attempts, retryAt });
    return { status: "retry", retryAt, error: result.userMessage };
  }

  if (result.destinationBroken) {
    await db.telegramBot
      .update({ where: { id: d.bot.id }, data: { status: "ERROR", lastError: result.userMessage, lastCheckedAt: new Date() } })
      .catch(() => undefined);
    if (d.alertId && !d.isTest) await db.alert.update({ where: { id: d.alertId }, data: { status: "ERROR" } }).catch(() => undefined);
  }
  logger.error("Notification failed", { deliveryId: id, detail: result.detail });
  return finish("FAILED", result.userMessage, result.detail);
}

/**
 * Outbox recovery: picks up deliveries that are due but not being processed — after a worker restart, a crash
 * mid-send (lock expired), Redis being unavailable, or scheduled retries.
 */
export async function sweepDueDeliveries(limit = 50, olderThanMs = 0): Promise<number> {
  const now = new Date();
  const due = await db.telegramDelivery.findMany({
    where: {
      createdAt: { lte: new Date(now.getTime() - olderThanMs) },
      OR: [
        { status: { in: DUE_STATUSES }, nextAttemptAt: { lte: now } },
        { status: "SENDING", lockedUntil: { lt: now } },
      ],
    },
    select: { id: true },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  let processed = 0;
  // Sequential per sweep keeps us well within Telegram's rate limits.
  for (const { id } of due) {
    const r = await processDelivery(id);
    if (r.status !== "skipped") processed++;
  }
  return processed;
}

/** Re-queues FAILED / DEAD_LETTER notifications (e.g. after fixing the bot). Returns how many. */
export async function retryFailedDeliveries(userId: string, since = new Date(Date.now() - 7 * 86_400_000)) {
  const rows = await db.telegramDelivery.findMany({
    where: { userId, isTest: false, status: { in: ["FAILED", "DEAD_LETTER"] }, createdAt: { gte: since } },
    select: { id: true, alertEventId: true },
  });
  if (!rows.length) return 0;
  await db.telegramDelivery.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: "QUEUED", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, error: null, errorDetail: null },
  });
  const events = rows.map((r) => r.alertEventId).filter((x): x is string => !!x);
  if (events.length) await db.alertEvent.updateMany({ where: { id: { in: events } }, data: { status: "QUEUED" } });
  return rows.length;
}
