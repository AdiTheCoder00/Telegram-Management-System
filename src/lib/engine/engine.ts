import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Prisma } from "@/generated/prisma/client";
import type { Alert, TelegramBot } from "@/generated/prisma/client";
import { evaluate, type AlertState, type Evaluation } from "@/lib/engine/evaluate";
import { GLOBAL_SCOPE, recordQuote } from "@/lib/engine/quotes";
import { buildAlertMessage, type MessageExtras } from "@/lib/notifications/messages";
import { recordTickCandle } from "@/lib/market/service";
import { EVALUATION_ENGINE_VERSION } from "@/lib/conditions/types";
import { INDICATOR_ENGINE_VERSION } from "@/lib/indicators";
import { CONDITION_LABELS } from "@/lib/constants";

export interface TickInput {
  provider: string;
  /** "global" for shared feeds; a userId for user-scoped webhook feeds (only that user's alerts are evaluated). */
  scope: string;
  symbol: string;
  price: number;
  time?: Date;
}

export interface Triggered {
  alertId: string;
  eventId: string;
  deliveryId: string | null;
}

export interface TickResult {
  quote: "new" | "duplicate" | "stale";
  evaluated: number;
  triggered: Triggered[];
}

export function toState(a: Alert): AlertState {
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

type AlertWithBot = Alert & { bot: TelegramBot | null; user: { timezone: string } };

export interface TriggerEvidenceInput {
  idempotencyKey: string;
  provider: string;
  timeframe: string | null;
  candleOpenTime: Date | null;
  candleState: string | null;
  price: number;
  marketDataTime: Date | null;
  providerMeta?: Prisma.InputJsonValue;
  evaluation: Prisma.InputJsonValue;
  reason: string;
}

/**
 * Persists one evaluation outcome atomically:
 *   optimistic state update (WHERE version = read version) — loses cleanly to a concurrent evaluation
 *   + on trigger: AlertEvent + immutable TriggerEvidence (UNIQUE idempotency key) + QUEUED delivery (outbox)
 * A duplicate idempotency key (same event processed twice, retries, redelivery, a second worker) aborts the
 * whole transaction, so a duplicate can never produce a second event or notification.
 */
export async function commitEvaluation(
  alert: AlertWithBot,
  ev: Evaluation,
  now: Date,
  extra: { lastEvaluatedCandle?: Date | null; marketDataState?: string | null; lastEvaluationNote?: string | null },
  trigger: { evidence: TriggerEvidenceInput; message: MessageExtras } | null,
): Promise<Triggered | null> {
  const message =
    ev.trigger && trigger && alert.bot
      ? await buildAlertMessage(alert, { price: trigger.evidence.price, at: now, timezone: alert.user.timezone, extras: trigger.message })
      : null;
  try {
    return await db.$transaction(async (tx) => {
      const updated = await tx.alert.updateMany({
        where: { id: alert.id, version: alert.version },
        data: {
          armed: ev.next.armed,
          lastPrice: ev.next.lastPrice,
          triggerCount: ev.next.triggerCount,
          lastTriggeredAt: ev.next.lastTriggeredAt,
          status: ev.next.status,
          lastEvaluatedAt: now,
          ...(extra.lastEvaluatedCandle !== undefined ? { lastEvaluatedCandle: extra.lastEvaluatedCandle } : {}),
          ...(extra.marketDataState !== undefined ? { marketDataState: extra.marketDataState } : {}),
          ...(extra.lastEvaluationNote !== undefined ? { lastEvaluationNote: extra.lastEvaluationNote } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) return null; // lost the race — another evaluation already handled this state
      if (!ev.trigger || !trigger) return null;

      const event = await tx.alertEvent.create({
        data: {
          alertId: alert.id,
          userId: alert.userId,
          alertName: alert.name,
          symbol: alert.symbol,
          conditionType: alert.conditionType,
          triggerPrice: trigger.evidence.price,
          previousPrice: alert.lastPrice,
          targetPrice: alert.targetPrice,
          alertVersion: alert.configVersion,
          triggeredAt: now,
          status: alert.bot ? "QUEUED" : "FAILED",
        },
      });
      await tx.triggerEvidence.create({
        data: {
          alertEventId: event.id,
          alertId: alert.id,
          userId: alert.userId,
          alertVersion: alert.configVersion,
          idempotencyKey: trigger.evidence.idempotencyKey,
          symbol: alert.symbol,
          provider: trigger.evidence.provider,
          timeframe: trigger.evidence.timeframe,
          evaluationMode: alert.evaluationMode,
          candleOpenTime: trigger.evidence.candleOpenTime,
          candleState: trigger.evidence.candleState,
          price: trigger.evidence.price,
          marketDataTime: trigger.evidence.marketDataTime,
          providerMeta: trigger.evidence.providerMeta,
          evaluation: trigger.evidence.evaluation,
          reason: trigger.evidence.reason,
          evaluationEngineVersion: EVALUATION_ENGINE_VERSION,
          indicatorEngineVersion: INDICATOR_ENGINE_VERSION,
        },
      });

      if (!alert.bot) {
        await tx.alert.update({
          where: { id: alert.id },
          data: { lastError: "No Telegram bot is assigned to this alert, so the notification could not be sent." },
        });
        return { alertId: alert.id, eventId: event.id, deliveryId: null };
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
      return { alertId: alert.id, eventId: event.id, deliveryId: delivery.id };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.info("Duplicate trigger suppressed (idempotency key exists)", { alertId: alert.id, key: trigger?.evidence.idempotencyKey });
      return null;
    }
    throw err;
  }
}

/**
 * Feeds one price update through the alert engine (PRICE alerts):
 *   quote dedupe → 1m tick candle → load matching live alerts → evaluate → commitEvaluation()
 * Condition-tree alerts are evaluated on candles by condition-engine.ts (tick candles feed them too).
 */
export async function processPriceTick(input: TickInput): Promise<TickResult> {
  const time = input.time ?? new Date();
  const quote = await recordQuote(input.provider, input.scope, input.symbol, input.price, time);
  if (quote !== "new") {
    logger.debug("Tick ignored", { ...input, quote });
    return { quote, evaluated: 0, triggered: [] };
  }
  await recordTickCandle(input.provider, input.scope, input.symbol, input.price, time).catch((err) =>
    logger.warn("Tick candle update failed", { err: String(err) }),
  );

  const alerts = await db.alert.findMany({
    where: {
      kind: "PRICE",
      status: { in: ["ACTIVE", "COOLDOWN"] }, // COOLDOWN alerts stay loaded so they can return to ACTIVE
      dataProvider: input.provider,
      symbol: input.symbol,
      ...(input.scope !== GLOBAL_SCOPE ? { userId: input.scope } : {}),
    },
    include: { bot: true, user: { select: { timezone: true } } },
  });

  const result: TickResult = { quote, evaluated: alerts.length, triggered: [] };
  const now = new Date();

  await Promise.all(
    alerts.map(async (alert) => {
      try {
        const ev = evaluate(toState(alert), input.price, now);
        const stateChanged =
          ev.trigger || ev.next.armed !== alert.armed || ev.next.status !== alert.status || ev.next.lastPrice !== alert.lastPrice;
        if (!stateChanged) return;
        const out = await commitEvaluation(
          alert,
          ev,
          now,
          { marketDataState: "FRESH", lastEvaluationNote: null },
          ev.trigger
            ? {
                evidence: {
                  // One trigger per alert version per accepted price tick (ticks are already de-duplicated by time).
                  idempotencyKey: `${alert.id}:v${alert.configVersion}:${input.provider}:${input.scope}:${input.symbol}:tick:${time.getTime()}`,
                  provider: input.provider,
                  timeframe: null,
                  candleOpenTime: null,
                  candleState: null,
                  price: input.price,
                  marketDataTime: time,
                  providerMeta: { scope: input.scope === GLOBAL_SCOPE ? "global" : "user" },
                  evaluation: {
                    type: "price",
                    condition: alert.conditionType,
                    label: `${CONDITION_LABELS[alert.conditionType]} ${alert.targetPrice}`,
                    price: input.price,
                    previousPrice: alert.lastPrice,
                    target: alert.targetPrice,
                    tolerance: alert.tolerance,
                    result: true,
                  },
                  reason: `${alert.symbol} ${input.price} — ${CONDITION_LABELS[alert.conditionType].toLowerCase()} ${alert.targetPrice}${
                    alert.lastPrice !== null ? ` (previous ${alert.lastPrice})` : ""
                  }.`,
                },
                message: {},
              }
            : null,
        );
        if (out) {
          result.triggered.push(out);
          logger.info("Alert triggered", { alertId: alert.id, symbol: alert.symbol, price: input.price, target: alert.targetPrice });
        }
      } catch (err) {
        logger.error("Alert evaluation failed", { alertId: alert.id, err });
      }
    }),
  );

  return result;
}

/** Marks live/paused alerts whose expiry date has passed as EXPIRED (runs on every poll cycle). */
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
