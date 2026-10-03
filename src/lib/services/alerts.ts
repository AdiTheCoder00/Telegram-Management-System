import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getLimits } from "@/lib/plans";
import { isValidProvider } from "@/lib/market-data/registry";
import { latestQuote, latestQuotesFor } from "@/lib/engine/quotes";
import { isExpiredByDate } from "@/lib/engine/evaluate";
import { buildAlertMessage } from "@/lib/notifications/messages";
import { processDelivery } from "@/lib/notifications/delivery";
import { SAMPLE_VARS, validateTemplate } from "@/lib/telegram/template";
import type { Alert, Prisma, TelegramBot } from "@/generated/prisma/client";
import type { AlertInput } from "@/lib/validation";
import type { z } from "zod";
import type { alertListQuerySchema } from "@/lib/validation";

type AlertWithBot = Alert & { bot: Pick<TelegramBot, "id" | "name" | "status" | "chatId" | "chatTitle"> | null };

export function serializeAlert(a: AlertWithBot, currentPrice?: number | null) {
  return {
    id: a.id,
    name: a.name,
    symbol: a.symbol,
    dataProvider: a.dataProvider,
    conditionType: a.conditionType,
    targetPrice: a.targetPrice,
    tolerance: a.tolerance,
    telegramBotId: a.telegramBotId,
    bot: a.bot ? { id: a.bot.id, name: a.bot.name, status: a.bot.status, chatTitle: a.bot.chatTitle } : null,
    messageTemplate: a.messageTemplate,
    parseMode: a.parseMode,
    status: a.status,
    triggerMode: a.triggerMode,
    cooldownSeconds: a.cooldownSeconds,
    expiryType: a.expiryType,
    expiresAt: a.expiresAt,
    maxTriggers: a.maxTriggers,
    triggerCount: a.triggerCount,
    lastTriggeredAt: a.lastTriggeredAt,
    lastError: a.lastError,
    armed: a.armed,
    currentPrice: currentPrice ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
export type AlertDTO = ReturnType<typeof serializeAlert>;

const botSelect = { select: { id: true, name: true, status: true, chatId: true, chatTitle: true } } as const;

export async function getOwnedAlert(userId: string, id: string) {
  const alert = await db.alert.findFirst({ where: { id, userId }, include: { bot: botSelect } });
  if (!alert) throw notFound("Alert");
  return alert;
}

export async function listAlerts(userId: string, q: z.infer<typeof alertListQuerySchema> = {}) {
  const where: Prisma.AlertWhereInput = { userId };
  // "Active" means live alerts: ACTIVE plus those riding out a post-trigger cooldown.
  if (q.status) where.status = q.status === "ACTIVE" ? { in: ["ACTIVE", "COOLDOWN"] } : q.status;
  if (q.symbol) where.symbol = q.symbol;
  if (q.botId) where.telegramBotId = q.botId;
  if (q.q) where.OR = [{ name: { contains: q.q, mode: "insensitive" } }, { symbol: { contains: q.q.toUpperCase() } }];
  const alerts = await db.alert.findMany({ where, include: { bot: botSelect }, orderBy: { createdAt: "desc" }, take: 500 });
  const quotes = await latestQuotesFor(
    alerts.map((a) => ({ provider: a.dataProvider, symbol: a.symbol })),
    userId,
  );
  return alerts.map((a) => serializeAlert(a, quotes.get(`${a.dataProvider}:${a.symbol}`)?.price));
}

async function validateAlertInput(userId: string, input: AlertInput) {
  if (!isValidProvider(input.dataProvider))
    throw badRequest("Unknown market-data provider.", { fieldErrors: { dataProvider: "Unknown provider." } });
  if (input.status === "ACTIVE" && !input.telegramBotId)
    throw badRequest("Choose a Telegram bot for this alert.", { fieldErrors: { telegramBotId: "Choose a Telegram bot." } });
  if (input.telegramBotId) {
    const bot = await db.telegramBot.findFirst({ where: { id: input.telegramBotId, userId }, select: { id: true, enabled: true } });
    if (!bot) throw badRequest("Selected Telegram bot was not found.", { fieldErrors: { telegramBotId: "Bot not found." } });
    if (input.status === "ACTIVE" && !bot.enabled)
      throw badRequest("The selected Telegram bot is disabled. Enable it, choose another bot, or save the alert paused.", {
        fieldErrors: { telegramBotId: "This bot is disabled." },
      });
  }
  const issues = validateTemplate(input.messageTemplate, input.parseMode, SAMPLE_VARS).filter((i) => i.level === "error");
  if (issues.length)
    throw new AppError(400, "The Telegram message has problems. Please fix them before saving.", "validation_error", {
      fieldErrors: { messageTemplate: issues[0].message },
      issues,
    });
}

/**
 * Authoritative activation gate (spec 0.34): an alert may not become ACTIVE until its stored
 * configuration validates — symbol, provider capability, condition/thresholds (enforced by the zod
 * schema at write time), notification config, template, cooldown and expiration. Used by every path
 * that moves an alert into ACTIVE (create/update run the same checks through validateAlertInput).
 */
async function assertActivatable(userId: string, a: Alert) {
  if (!a.symbol.trim()) throw badRequest("This alert has no symbol. Edit it before activating.");
  if (!isValidProvider(a.dataProvider))
    throw badRequest("This alert uses a market-data provider that no longer exists. Edit it before activating.");
  if (!Number.isFinite(a.targetPrice) || a.targetPrice <= 0)
    throw badRequest("This alert has no valid target price. Edit it before activating.");
  if (a.cooldownSeconds < 0) throw badRequest("This alert has an invalid cooldown. Edit it before activating.");
  if (isExpiredByDate(a, new Date())) throw badRequest("This alert's expiry date has passed. Edit the alert to set a new date.");
  if (!a.telegramBotId) throw badRequest("Assign a Telegram bot to this alert before activating it.");
  const bot = await db.telegramBot.findFirst({ where: { id: a.telegramBotId, userId }, select: { enabled: true } });
  if (!bot) throw badRequest("The Telegram bot assigned to this alert no longer exists. Choose another bot.");
  if (!bot.enabled) throw badRequest("This alert’s Telegram bot is disabled. Enable the bot before activating the alert.");
  const issues = validateTemplate(a.messageTemplate, a.parseMode, SAMPLE_VARS).filter((i) => i.level === "error");
  if (issues.length)
    throw new AppError(400, "The Telegram message has problems. Fix them before activating this alert.", "validation_error", {
      fieldErrors: { messageTemplate: issues[0].message },
      issues,
    });
}

function dataFromInput(input: AlertInput) {
  return {
    name: input.name,
    symbol: input.symbol,
    dataProvider: input.dataProvider,
    conditionType: input.conditionType,
    targetPrice: input.targetPrice,
    tolerance: input.conditionType === "PRICE_EQUALS" ? input.tolerance : 0,
    telegramBotId: input.telegramBotId,
    messageTemplate: input.messageTemplate,
    parseMode: input.parseMode,
    triggerMode: input.triggerMode,
    cooldownSeconds: input.cooldownSeconds,
    expiryType: input.expiryType,
    expiresAt: input.expiryType === "AT_DATE" ? (input.expiresAt ?? null) : null,
    maxTriggers: input.expiryType === "AFTER_N_TRIGGERS" ? (input.maxTriggers ?? null) : null,
  };
}

export async function createAlert(userId: string, input: AlertInput) {
  const [count, limits] = await Promise.all([db.alert.count({ where: { userId } }), getLimits(userId)]);
  if (count >= limits.maxAlerts) throw new AppError(403, `You can create up to ${limits.maxAlerts} alerts on your plan.`, "limit");
  await validateAlertInput(userId, input);
  const alert = await db.alert.create({
    data: { userId, ...dataFromInput(input), status: input.status },
    include: { bot: botSelect },
  });
  logger.info("Alert created", { userId, alertId: alert.id, symbol: alert.symbol });
  return serializeAlert(alert);
}

/** Full update (PUT). Changing what is being watched resets the engine state so stale state can't misfire. */
export async function updateAlert(userId: string, id: string, input: AlertInput) {
  const existing = await getOwnedAlert(userId, id);
  await validateAlertInput(userId, input);
  const data = dataFromInput(input);
  const watchChanged =
    existing.symbol !== data.symbol ||
    existing.dataProvider !== data.dataProvider ||
    existing.conditionType !== data.conditionType ||
    existing.targetPrice !== data.targetPrice ||
    existing.triggerMode !== data.triggerMode;

  // Status: honour Active/Paused from the form. Editing a Triggered/Expired/Error alert and saving it
  // as Active re-activates it with a fresh trigger budget.
  // COOLDOWN is live (not a reactivation): editing it must not reset its trigger budget or cooldown.
  const wasLive = existing.status === "ACTIVE" || existing.status === "COOLDOWN";
  const reactivating = input.status === "ACTIVE" && !wasLive;
  if (input.status === "ACTIVE" && isExpiredByDate({ expiryType: data.expiryType, expiresAt: data.expiresAt }, new Date()))
    throw badRequest("The expiry date is in the past.");

  const alert = await db.alert.update({
    where: { id },
    data: {
      ...data,
      // Saving a cooling-down alert as "Active" keeps it in COOLDOWN; the engine releases it when the window ends.
      status: wasLive && input.status === "ACTIVE" ? existing.status : input.status,
      version: { increment: 1 },
      ...(watchChanged || reactivating ? { armed: true, lastPrice: null } : {}),
      ...(reactivating ? { triggerCount: 0, lastError: null } : {}),
    },
    include: { bot: botSelect },
  });
  return serializeAlert(alert);
}

export async function pauseAlert(userId: string, id: string) {
  await getOwnedAlert(userId, id);
  const alert = await db.alert.update({
    where: { id },
    data: { status: "PAUSED", version: { increment: 1 } },
    include: { bot: botSelect },
  });
  return serializeAlert(alert);
}

/**
 * Resumes/activates an alert (PAUSED, DRAFT, TRIGGERED, EXPIRED, ERROR → ACTIVE). The full
 * activation validation (spec 0.34) must pass first. The alert is re-armed and its last price
 * cleared, so a "crosses" alert needs a fresh crossing and an "above" alert fires again only if
 * price is (still) above the target.
 */
export async function resumeAlert(userId: string, id: string) {
  const a = await getOwnedAlert(userId, id);
  await assertActivatable(userId, a);
  const resetBudget = a.status === "TRIGGERED" || a.status === "EXPIRED" || a.status === "DRAFT";
  const alert = await db.alert.update({
    where: { id },
    data: {
      status: "ACTIVE",
      armed: true,
      lastPrice: null,
      lastError: null,
      version: { increment: 1 },
      ...(resetBudget ? { triggerCount: 0 } : {}),
    },
    include: { bot: botSelect },
  });
  return serializeAlert(alert);
}

export async function deleteAlert(userId: string, id: string) {
  await getOwnedAlert(userId, id);
  await db.alert.delete({ where: { id } }); // history rows keep a snapshot (alertId set null)
  logger.info("Alert deleted", { userId, alertId: id });
}

export async function duplicateAlert(userId: string, id: string) {
  const a = await getOwnedAlert(userId, id);
  const copy = await db.alert.create({
    data: {
      userId,
      name: `${a.name} (copy)`.slice(0, 100),
      symbol: a.symbol,
      dataProvider: a.dataProvider,
      conditionType: a.conditionType,
      conditionParams: a.conditionParams ?? undefined,
      targetPrice: a.targetPrice,
      tolerance: a.tolerance,
      telegramBotId: a.telegramBotId,
      messageTemplate: a.messageTemplate,
      parseMode: a.parseMode,
      triggerMode: a.triggerMode,
      cooldownSeconds: a.cooldownSeconds,
      expiryType: a.expiryType,
      expiresAt: a.expiresAt && a.expiresAt > new Date() ? a.expiresAt : null,
      maxTriggers: a.maxTriggers,
      status: "PAUSED", // copies start paused so they can be adjusted before going live
    },
    include: { bot: botSelect },
  });
  return serializeAlert(copy);
}

/** Sends the alert's real message template immediately, marked as a test. Logged in history. */
export async function sendTestAlert(userId: string, id: string) {
  const a = await getOwnedAlert(userId, id);
  if (!a.bot) throw badRequest("Assign a Telegram bot to this alert first.");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } });
  const quote = await latestQuote(a.dataProvider, a.symbol, userId);
  const price = quote?.price ?? a.targetPrice;
  const message = await buildAlertMessage(a, { price, timezone: user.timezone, test: true });

  const { delivery } = await db.$transaction(async (tx) => {
    const event = await tx.alertEvent.create({
      data: {
        alertId: a.id,
        userId,
        alertName: a.name,
        symbol: a.symbol,
        conditionType: a.conditionType,
        triggerPrice: price,
        targetPrice: a.targetPrice,
        isTest: true,
      },
    });
    const delivery = await tx.telegramDelivery.create({
      data: {
        userId,
        alertId: a.id,
        alertEventId: event.id,
        telegramBotId: a.bot!.id,
        chatId: a.bot!.chatId,
        message,
        parseMode: a.parseMode,
        isTest: true,
      },
    });
    return { delivery };
  });
  // Tests are user-initiated and the user is waiting for feedback, so we send synchronously.
  const outcome = await processDelivery(delivery.id);
  return { deliveryId: delivery.id, ...outcome };
}
