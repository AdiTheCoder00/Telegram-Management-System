import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Alert } from "@/generated/prisma/client";
import { evaluate, type AlertState } from "@/lib/engine/evaluate";
import { GLOBAL_SCOPE, recordQuote } from "@/lib/engine/quotes";
import { buildAlertMessage } from "@/lib/notifications/messages";

export interface TickInput {
  provider: string;
  /** "global" for shared feeds; a userId for user-scoped webhook feeds (only that user's alerts are evaluated). */
  scope: string;
  symbol: string;
  price: number;
  time?: Date;
}

export interface TickResult {
  quote: "new" | "duplicate" | "stale";
  evaluated: number;
  triggered: { alertId: string; eventId: string; deliveryId: string | null }[];
}

function toState(a: Alert): AlertState {
  return {
    conditionType: a.conditionType,
    targetPrice: a.targetPrice,
    tolerance: a.tolerance,
    triggerMode: a.triggerMode,
    cooldownSeconds: a.cooldownSeconds,
    expiryType: a.expiryType,
    expiresAt: a.expiresAt,
    maxTriggers: a.maxTriggers,
    triggerCount: a.triggerCount,
    lastTriggeredAt: a.lastTriggeredAt,
    armed: a.armed,
    lastPrice: a.lastPrice,
    status: a.status,
  };
}

/**
 * Feeds one price update through the alert engine:
 *   quote dedupe → load matching ACTIVE alerts → evaluate → optimistic-locked state write
 *   → (on trigger) AlertEvent + TelegramDelivery rows written in the same transaction (outbox).
 *
 * The caller enqueues the returned delivery ids. Because each alert row is updated with
 * `WHERE version = <read version>`, concurrent ticks (poller + webhook, two worker replicas, retries)
 * can never trigger the same alert twice for the same state transition.
 */
export async function processPriceTick(input: TickInput): Promise<TickResult> {
  const time = input.time ?? new Date();
  const quote = await recordQuote(input.provider, input.scope, input.symbol, input.price, time);
  if (quote !== "new") {
    logger.debug("Tick ignored", { ...input, quote });
    return { quote, evaluated: 0, triggered: [] };
  }

  const alerts = await db.alert.findMany({
    where: {
      status: { in: ["ACTIVE", "COOLDOWN"] }, // COOLDOWN alerts stay loaded so they can return to ACTIVE
      dataProvider: input.provider,
      symbol: input.symbol,
      ...(input.scope !== GLOBAL_SCOPE ? { userId: input.scope } : {}),
    },
    include: { bot: true, user: { select: { timezone: true } } },
  });

  const result: TickResult = { quote, evaluated: alerts.length, triggered: [] };
  const now = new Date();

  // Alerts are independent; evaluate them concurrently (bounded by the DB pool).
  await Promise.all(
    alerts.map(async (alert) => {
      try {
        const ev = evaluate(toState(alert), input.price, now);
        const stateChanged =
          ev.trigger || ev.next.armed !== alert.armed || ev.next.status !== alert.status || ev.next.lastPrice !== alert.lastPrice;
        if (!stateChanged) return;

        // Render outside the transaction to keep it short (no extra queries while row locks are held).
        const message =
          ev.trigger && alert.bot ? await buildAlertMessage(alert, { price: input.price, at: now, timezone: alert.user.timezone }) : null;

        const out = await db.$transaction(async (tx) => {
          const updated = await tx.alert.updateMany({
            where: { id: alert.id, version: alert.version },
            data: {
              armed: ev.next.armed,
              lastPrice: ev.next.lastPrice,
              triggerCount: ev.next.triggerCount,
              lastTriggeredAt: ev.next.lastTriggeredAt,
              status: ev.next.status,
              lastEvaluatedAt: now,
              version: { increment: 1 },
            },
          });
          if (updated.count === 0) return null; // lost the race — another tick already handled this state
          if (!ev.trigger) return null;

          const event = await tx.alertEvent.create({
            data: {
              alertId: alert.id,
              userId: alert.userId,
              alertName: alert.name,
              symbol: alert.symbol,
              conditionType: alert.conditionType,
              triggerPrice: input.price,
              previousPrice: alert.lastPrice,
              targetPrice: alert.targetPrice,
              triggeredAt: now,
              status: alert.bot ? "PENDING" : "FAILED",
            },
          });

          if (!alert.bot) {
            await tx.alert.update({
              where: { id: alert.id },
              data: { lastError: "No Telegram bot is assigned to this alert, so the notification could not be sent." },
            });
            return { eventId: event.id, deliveryId: null };
          }

          const delivery = await tx.telegramDelivery.create({
            data: {
              userId: alert.userId,
              alertId: alert.id,
              alertEventId: event.id,
              telegramBotId: alert.bot.id,
              chatId: alert.bot.chatId,
              message: message ?? "",
              parseMode: alert.parseMode,
            },
          });
          return { eventId: event.id, deliveryId: delivery.id };
        });

        if (out) {
          result.triggered.push({ alertId: alert.id, ...out });
          logger.info("Alert triggered", {
            alertId: alert.id,
            symbol: alert.symbol,
            price: input.price,
            target: alert.targetPrice,
            condition: alert.conditionType,
          });
        }
      } catch (err) {
        logger.error("Alert evaluation failed", { alertId: alert.id, err });
      }
    }),
  );

  return result;
}

/** Marks ACTIVE/COOLDOWN alerts whose expiry date has passed as EXPIRED (runs on every poll cycle). */
export async function expireDueAlerts(now = new Date()) {
  const res = await db.alert.updateMany({
    where: { status: { in: ["ACTIVE", "PAUSED", "COOLDOWN"] }, expiryType: "AT_DATE", expiresAt: { lte: now } },
    data: { status: "EXPIRED", version: { increment: 1 } },
  });
  if (res.count) logger.info("Expired alerts", { count: res.count });
  return res.count;
}

/**
 * Returns COOLDOWN alerts whose window has ended to ACTIVE. Ticks do this too, but a quiet feed
 * (e.g. a webhook symbol) may not tick for a long time, so the poll cycle sweeps as well.
 * Version-bumped like every state transition so concurrent evaluations stay consistent.
 */
export async function releaseFinishedCooldowns(now = new Date()) {
  const count = await db.$executeRaw`
    UPDATE "Alert" SET "status" = 'ACTIVE', "version" = "version" + 1, "updatedAt" = ${now}
    WHERE "status" = 'COOLDOWN'
      AND ("lastTriggeredAt" IS NULL OR "lastTriggeredAt" + make_interval(secs => "cooldownSeconds") <= ${now})`;
  if (count) logger.debug("Released finished cooldowns", { count });
  return count;
}
