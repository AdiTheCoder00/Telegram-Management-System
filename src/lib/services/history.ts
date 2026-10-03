import { notFound } from "@/lib/errors";
import type { DeliveryStatusT } from "@/lib/constants";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { z } from "zod";
import type { historyQuerySchema } from "@/lib/validation";

type HistoryQuery = z.infer<typeof historyQuerySchema>;

export async function getHistory(userId: string, q: HistoryQuery) {
  const where: Prisma.AlertEventWhereInput = { userId };
  if (q.symbol) where.symbol = q.symbol;
  if (q.status) where.status = q.status;
  if (q.alertId) where.alertId = q.alertId;
  if (q.includeTests !== "true") where.isTest = false;
  if (q.from || q.to) where.triggeredAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };

  const [total, rows] = await Promise.all([
    db.alertEvent.count({ where }),
    db.alertEvent.findMany({
      where,
      orderBy: { triggeredAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        deliveries: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { bot: { select: { id: true, name: true } } },
        },
        evidence: { select: { id: true, reason: true, timeframe: true, evaluationMode: true, candleOpenTime: true, alertVersion: true } },
      },
    }),
  ]);

  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    items: rows.map((e) => {
      const d = e.deliveries[0];
      return {
        id: e.id,
        alertId: e.alertId,
        alertName: e.alertName,
        symbol: e.symbol,
        conditionType: e.conditionType,
        triggerPrice: e.triggerPrice,
        previousPrice: e.previousPrice,
        targetPrice: e.targetPrice,
        triggeredAt: e.triggeredAt,
        isTest: e.isTest,
        status: e.status,
        alertVersion: e.alertVersion,
        evidence: e.evidence,
        delivery: d
          ? {
              id: d.id,
              status: d.status,
              botName: d.bot?.name ?? "Deleted bot",
              chatId: d.chatId,
              error: d.error,
              sentAt: d.sentAt,
              attempts: d.attempts,
              telegramMessageId: d.telegramMessageId,
            }
          : null,
      };
    }),
  };
}
export type HistoryItem = Awaited<ReturnType<typeof getHistory>>["items"][number];

export async function getDeliveryLogs(userId: string, q: { status?: DeliveryStatusT; page: number; pageSize: number }) {
  const where: Prisma.TelegramDeliveryWhereInput = { userId, ...(q.status ? { status: q.status } : {}) };
  const [total, rows] = await Promise.all([
    db.telegramDelivery.count({ where }),
    db.telegramDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { bot: { select: { name: true } }, alert: { select: { name: true } } },
    }),
  ]);
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    items: rows.map((d) => ({
      id: d.id,
      alertId: d.alertId,
      alertName: d.alert?.name ?? null,
      alertEventId: d.alertEventId,
      botId: d.telegramBotId,
      botName: d.bot?.name ?? "Deleted bot",
      chatId: d.chatId,
      message: d.message,
      parseMode: d.parseMode,
      isTest: d.isTest,
      status: d.status,
      telegramMessageId: d.telegramMessageId,
      error: d.error,
      errorDetail: d.errorDetail,
      attempts: d.attempts,
      sentAt: d.sentAt,
      createdAt: d.createdAt,
    })),
  };
}
export type DeliveryLogItem = Awaited<ReturnType<typeof getDeliveryLogs>>["items"][number];

/**
 * Full trigger evidence for one history event ("Why did this alert trigger?"): the immutable record written in
 * the same transaction as the event — market data used, candle, evaluation tree with every operand's value,
 * engine versions and the alert configuration version that was active.
 */
export async function getEventEvidence(userId: string, eventId: string) {
  const event = await db.alertEvent.findFirst({
    where: { id: eventId, userId },
    include: {
      evidence: true,
      deliveries: {
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, attempts: true, error: true, sentAt: true, createdAt: true },
      },
    },
  });
  if (!event) throw notFound("History event");
  const version =
    event.alertId && event.alertVersion
      ? await db.alertVersion.findUnique({ where: { alertId_version: { alertId: event.alertId, version: event.alertVersion } } })
      : null;
  return {
    event: {
      id: event.id,
      alertId: event.alertId,
      alertName: event.alertName,
      symbol: event.symbol,
      triggeredAt: event.triggeredAt,
      triggerPrice: event.triggerPrice,
      previousPrice: event.previousPrice,
      targetPrice: event.targetPrice,
      conditionType: event.conditionType,
      isTest: event.isTest,
      status: event.status,
      alertVersion: event.alertVersion,
    },
    evidence: event.evidence,
    config: version?.config ?? null,
    deliveries: event.deliveries,
  };
}
