import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getLimits } from "@/lib/plans";
import { sendMessage, TelegramError, verifyConnection } from "@/lib/telegram/client";
import { processDelivery } from "@/lib/notifications/delivery";
import { applyChatMigration } from "@/lib/telegram/migration";
import type { TelegramBot } from "@/generated/prisma/client";
import type { ParseModeT } from "@/lib/constants";
import { validateMessage } from "@/lib/telegram/format";
import type { z } from "zod";
import type { createBotSchema, updateBotSchema } from "@/lib/validation";

/** Public representation of a bot — the token (encrypted or not) is never included. */
export function serializeBot(bot: TelegramBot & { _count?: { alerts: number } }) {
  return {
    id: bot.id,
    name: bot.name,
    tokenHint: `••••${bot.tokenHint}`,
    botUsername: bot.botUsername,
    chatId: bot.chatId,
    chatTitle: bot.chatTitle,
    enabled: bot.enabled,
    status: bot.status,
    lastError: bot.lastError,
    lastCheckedAt: bot.lastCheckedAt,
    alertCount: bot._count?.alerts ?? undefined,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}
export type BotDTO = ReturnType<typeof serializeBot>;

export async function listBots(userId: string) {
  const bots = await db.telegramBot.findMany({
    where: { userId },
    include: { _count: { select: { alerts: true } } },
    orderBy: { createdAt: "asc" },
  });
  return bots.map(serializeBot);
}

export async function getOwnedBot(userId: string, id: string) {
  const bot = await db.telegramBot.findFirst({ where: { id, userId } });
  if (!bot) throw notFound("Telegram bot");
  return bot;
}

type CheckResult =
  | { status: "CONNECTED"; lastError: string | null; botUsername: string; chatTitle: string; chatId: string }
  | { status: "ERROR"; lastError: string; botUsername: null; chatTitle: null; chatId: string };

/**
 * getMe + getChat. If Telegram reports that the group was upgraded to a supergroup, the check is repeated
 * against the new chat ID (the old one no longer works) and the returned chatId is the new one.
 */
async function check(token: string, chatId: string): Promise<CheckResult> {
  try {
    const info = await verifyConnection(token, chatId);
    return { status: "CONNECTED", lastError: null, ...info, chatId };
  } catch (err) {
    if (err instanceof TelegramError && err.kind === "chat_migrated" && err.migrateToChatId) {
      const next = await check(token, err.migrateToChatId);
      if (next.status === "CONNECTED")
        return { ...next, lastError: `Chat ID updated automatically from ${chatId} to ${next.chatId} (group upgraded to supergroup).` };
      return next;
    }
    const msg = err instanceof TelegramError ? err.userMessage : "Could not verify the Telegram connection.";
    return { status: "ERROR", lastError: msg, botUsername: null, chatTitle: null, chatId };
  }
}

export async function createBot(userId: string, input: z.infer<typeof createBotSchema>) {
  const [count, limits] = await Promise.all([db.telegramBot.count({ where: { userId } }), getLimits(userId)]);
  if (count >= limits.maxBots) throw new AppError(403, `You can add up to ${limits.maxBots} bots.`, "limit");

  const result = await check(input.token, input.chatId);
  const bot = await db.telegramBot.create({
    data: {
      userId,
      name: input.name,
      encryptedToken: encrypt(input.token),
      tokenHint: input.token.slice(-4),
      chatId: result.chatId,
      status: result.status,
      lastError: result.lastError,
      botUsername: result.botUsername,
      chatTitle: result.chatTitle,
      lastCheckedAt: new Date(),
    },
  });
  logger.info("Telegram bot added", { userId, botId: bot.id, status: bot.status });
  return serializeBot(bot);
}

export async function updateBot(userId: string, id: string, input: z.infer<typeof updateBotSchema>) {
  const bot = await getOwnedBot(userId, id);
  const reverify = !!input.token || (input.chatId !== undefined && input.chatId !== bot.chatId);
  let result: CheckResult | null = null;
  if (reverify) {
    let token: string;
    try {
      token = input.token ?? decrypt(bot.encryptedToken);
    } catch {
      throw badRequest("The stored bot token could not be read. Please re-enter the token.");
    }
    result = await check(token, input.chatId ?? bot.chatId);
  }
  const updated = await db.telegramBot.update({
    where: { id },
    data: {
      name: input.name,
      enabled: input.enabled,
      chatId: result?.chatId ?? input.chatId,
      ...(input.token ? { encryptedToken: encrypt(input.token), tokenHint: input.token.slice(-4) } : {}),
      ...(result
        ? {
            status: result.status,
            lastError: result.lastError,
            botUsername: result.botUsername,
            chatTitle: result.chatTitle,
            lastCheckedAt: new Date(),
          }
        : {}),
    },
  });
  if (input.enabled !== undefined && input.enabled !== bot.enabled)
    logger.info(input.enabled ? "Telegram bot enabled" : "Telegram bot disabled", { userId, botId: id });
  return serializeBot(updated);
}

/** Verifies token + chat with getMe/getChat and stores the resulting status. Allowed while disabled. */
export async function verifyBot(userId: string, id: string) {
  const bot = await getOwnedBot(userId, id);
  let token: string;
  try {
    token = decrypt(bot.encryptedToken);
  } catch {
    throw badRequest("The stored bot token could not be read. Please re-enter the token.");
  }
  const result = await check(token, bot.chatId);
  if (result.chatId !== bot.chatId) await applyChatMigration(bot.id, bot.chatId, result.chatId);
  const updated = await db.telegramBot.update({
    where: { id },
    data: {
      status: result.status,
      lastError: result.lastError,
      botUsername: result.botUsername ?? bot.botUsername,
      chatTitle: result.chatTitle ?? bot.chatTitle,
      lastCheckedAt: new Date(),
    },
  });
  return serializeBot(updated);
}

/**
 * Deletes a bot. Alerts that used it are detached (FK SetNull) and flagged with an Error status
 * so the user sees they need a new destination; history and delivery logs are preserved.
 */
export async function deleteBot(userId: string, id: string) {
  await getOwnedBot(userId, id);
  const affected = await db.$transaction(async (tx) => {
    const res = await tx.alert.updateMany({
      where: { userId, telegramBotId: id, status: { in: ["ACTIVE", "PAUSED"] } },
      data: {
        status: "ERROR",
        lastError: "The Telegram bot for this alert was deleted. Edit the alert and choose another bot.",
        version: { increment: 1 },
      },
    });
    await tx.telegramBot.delete({ where: { id } });
    return res.count;
  });
  logger.info("Telegram bot deleted", { userId, botId: id, affectedAlerts: affected });
  return { affectedAlerts: affected };
}

const DEFAULT_TEST_MESSAGE = "✅ Test message from Levels.\nYour bot is connected and ready to send alerts.";

/** Sends a (logged) test message through a saved bot. */
export async function sendBotTestMessage(userId: string, id: string, message?: string, parseMode?: ParseModeT) {
  const bot = await getOwnedBot(userId, id);
  if (!bot.enabled) throw badRequest("This bot is disabled. Enable it to send messages.");
  if (parseMode && message) {
    const issues = validateMessage(message, parseMode).filter((i) => i.level === "error");
    if (issues.length) throw badRequest(issues[0].message);
  }
  const delivery = await db.telegramDelivery.create({
    data: {
      userId,
      telegramBotId: bot.id,
      chatId: bot.chatId,
      message: parseMode && message ? message : `🧪 ${message?.trim() || DEFAULT_TEST_MESSAGE}`,
      parseMode: parseMode && message ? parseMode : "PLAIN",
      isTest: true,
    },
  });
  const outcome = await processDelivery(delivery.id);
  return { deliveryId: delivery.id, ...outcome };
}

/** Sends a test message using an unsaved token/chat (from the "Add bot" form). Not persisted. */
export async function sendAdHocTestMessage(token: string, chatId: string, message?: string) {
  const result = await check(token, chatId);
  if (result.status !== "CONNECTED") return { status: "failed" as const, error: result.lastError };
  try {
    const msg = await sendMessage(token, result.chatId, `🧪 ${message?.trim() || DEFAULT_TEST_MESSAGE}`);
    return {
      status: "sent" as const,
      telegramMessageId: String(msg.message_id),
      botUsername: result.botUsername,
      chatTitle: result.chatTitle,
      // Present when Telegram reported a new ID for this group — the form should save this one.
      chatId: result.chatId,
      note: result.lastError,
    };
  } catch (err) {
    if (err instanceof TelegramError) return { status: "failed" as const, error: err.userMessage };
    throw err;
  }
}
