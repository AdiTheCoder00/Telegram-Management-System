import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { sendMessage, TelegramError } from "@/lib/telegram/client";
import type { DeliveryStatus } from "@/generated/prisma/client";

export const MAX_ATTEMPTS = 6;
const LOCK_MS = 60_000;

export type ProcessOutcome =
  | { status: "sent"; telegramMessageId: string }
  | { status: "retry"; retryAt: Date; error: string }
  | { status: "failed"; error: string }
  | { status: "skipped" }; // already processed / locked by another worker

function backoffMs(attempt: number) {
  return Math.min(5 * 60_000, 2_000 * 2 ** (attempt - 1)); // 2s, 4s, 8s … capped at 5min
}

async function syncEventStatus(eventId: string | null, status: DeliveryStatus) {
  if (eventId) await db.alertEvent.update({ where: { id: eventId }, data: { status } }).catch(() => undefined);
}

/**
 * Sends one TelegramDelivery. Safe to call concurrently and repeatedly (idempotent):
 * the row is claimed with a conditional update, so only one worker sends it.
 * Transient errors (network, 5xx, 429) are rescheduled with exponential backoff;
 * permanent errors (bad token, chat not found) fail immediately and flag the bot/alert.
 */
export async function processDelivery(id: string): Promise<ProcessOutcome> {
  const now = new Date();
  const claimed = await db.telegramDelivery.updateMany({
    where: {
      id,
      status: "PENDING",
      nextAttemptAt: { lte: new Date(now.getTime() + 2000) }, // small slack for app/DB clock skew
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return { status: "skipped" };

  const d = await db.telegramDelivery.findUniqueOrThrow({ where: { id }, include: { bot: true } });

  const fail = async (error: string, errorDetail?: string): Promise<ProcessOutcome> => {
    await db.telegramDelivery.update({
      where: { id },
      data: { status: "FAILED", error, errorDetail: errorDetail?.slice(0, 1000), lockedUntil: null },
    });
    await syncEventStatus(d.alertEventId, "FAILED");
    if (d.alertId && !d.isTest) await db.alert.update({ where: { id: d.alertId }, data: { lastError: error } }).catch(() => undefined);
    return { status: "failed", error };
  };

  if (!d.bot) return fail("The Telegram bot for this alert was deleted. Assign another bot to the alert.");

  let token: string;
  try {
    token = decrypt(d.bot.encryptedToken);
  } catch (err) {
    logger.error("Failed to decrypt bot token (ENCRYPTION_KEY changed?)", { botId: d.bot.id, err });
    return fail("The stored bot token could not be read. Please re-enter the bot token.", "decrypt_failed");
  }

  try {
    let msg;
    let note: string | null = null;
    try {
      msg = await sendMessage(token, d.chatId, d.message, d.parseMode);
    } catch (err) {
      // If formatting is invalid, deliver as plain text rather than losing the alert.
      if (err instanceof TelegramError && err.kind === "parse_error" && d.parseMode !== "PLAIN") {
        msg = await sendMessage(token, d.chatId, d.message, "PLAIN");
        note = "Sent as plain text because Telegram could not parse the message formatting.";
      } else throw err;
    }
    await db.telegramDelivery.update({
      where: { id },
      data: {
        status: "SENT",
        telegramMessageId: String(msg.message_id),
        sentAt: new Date(),
        lockedUntil: null,
        error: note,
      },
    });
    await syncEventStatus(d.alertEventId, "SENT");
    await db.telegramBot
      .update({ where: { id: d.bot.id }, data: { status: "CONNECTED", lastError: null, lastCheckedAt: new Date() } })
      .catch(() => undefined);
    if (d.alertId && !d.isTest) await db.alert.update({ where: { id: d.alertId }, data: { lastError: null } }).catch(() => undefined);
    logger.info("Telegram message sent", { deliveryId: id, chatId: d.chatId, messageId: msg.message_id });
    return { status: "sent", telegramMessageId: String(msg.message_id) };
  } catch (err) {
    const tg = err instanceof TelegramError ? err : new TelegramError("network", String(err));
    const attempts = d.attempts;
    if (tg.retryable && attempts < MAX_ATTEMPTS) {
      const delay = tg.retryAfterSec ? tg.retryAfterSec * 1000 : backoffMs(attempts);
      const retryAt = new Date(Date.now() + delay);
      await db.telegramDelivery.update({
        where: { id },
        data: { nextAttemptAt: retryAt, lockedUntil: null, error: tg.userMessage, errorDetail: tg.description },
      });
      logger.warn("Telegram delivery will be retried", { deliveryId: id, attempts, retryAt, kind: tg.kind });
      return { status: "retry", retryAt, error: tg.userMessage };
    }

    // Permanent failure: flag the bot so the UI shows Error status.
    if (["invalid_token", "chat_not_found", "bot_blocked"].includes(tg.kind)) {
      await db.telegramBot
        .update({ where: { id: d.bot.id }, data: { status: "ERROR", lastError: tg.userMessage, lastCheckedAt: new Date() } })
        .catch(() => undefined);
      if (d.alertId && !d.isTest) await db.alert.update({ where: { id: d.alertId }, data: { status: "ERROR" } }).catch(() => undefined);
    }
    logger.error("Telegram delivery failed", { deliveryId: id, kind: tg.kind, description: tg.description });
    return fail(tg.userMessage, `${tg.kind}: ${tg.description}`);
  }
}

/**
 * Outbox recovery: picks up deliveries that are due but not being processed — e.g. after a worker
 * restart, a crash mid-send (lock expired), Redis being unavailable, or scheduled retries.
 */
export async function sweepDueDeliveries(limit = 50, olderThanMs = 0): Promise<number> {
  const now = new Date();
  const due = await db.telegramDelivery.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: now },
      createdAt: { lte: new Date(now.getTime() - olderThanMs) },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
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
