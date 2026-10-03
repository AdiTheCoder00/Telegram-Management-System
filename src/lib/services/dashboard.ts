import { db } from "@/lib/db";
import { latestQuotesFor } from "@/lib/engine/quotes";
import { serializeAlert } from "@/lib/services/alerts";

/** Midnight "today" in the user's timezone, as a UTC Date. */
export function startOfDayInTz(tz: string, now = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = asUtc - now.getTime();
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset);
}

export type TelegramAggregateStatus = "CONNECTED" | "DISCONNECTED" | "ERROR";

export async function engineStatus() {
  const hb = await db.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: "desc" } });
  const online = !!hb && Date.now() - hb.lastSeenAt.getTime() < 30_000;
  return { online, lastSeenAt: hb?.lastSeenAt ?? null };
}

export async function getDashboard(userId: string, timezone: string) {
  const since = startOfDayInTz(timezone);
  const [total, active, triggeredToday, bots, recent, recentEvents, failed24h, engine] = await Promise.all([
    db.alert.count({ where: { userId } }),
    db.alert.count({ where: { userId, status: "ACTIVE" } }),
    db.alertEvent.count({ where: { userId, isTest: false, triggeredAt: { gte: since } } }),
    db.telegramBot.findMany({ where: { userId }, select: { status: true, name: true, lastError: true } }),
    db.alert.findMany({
      where: { userId },
      include: { bot: { select: { id: true, name: true, status: true, chatId: true, chatTitle: true } } },
      orderBy: [{ updatedAt: "desc" }],
      take: 6,
    }),
    db.alertEvent.findMany({
      where: { userId },
      orderBy: { triggeredAt: "desc" },
      take: 6,
    }),
    db.telegramDelivery.count({ where: { userId, status: "FAILED", createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    engineStatus(),
  ]);

  const telegramStatus: TelegramAggregateStatus = !bots.length
    ? "DISCONNECTED"
    : bots.some((b) => b.status === "ERROR")
      ? "ERROR"
      : bots.some((b) => b.status === "CONNECTED")
        ? "CONNECTED"
        : "DISCONNECTED";

  const quotes = await latestQuotesFor(
    recent.map((a) => ({ provider: a.dataProvider, symbol: a.symbol })),
    userId,
  );

  return {
    stats: { total, active, triggeredToday, failed24h },
    telegram: {
      status: telegramStatus,
      bots: bots.length,
      connected: bots.filter((b) => b.status === "CONNECTED").length,
      error: bots.find((b) => b.status === "ERROR")?.lastError ?? null,
    },
    engine,
    recentAlerts: recent.map((a) => serializeAlert(a, quotes.get(`${a.dataProvider}:${a.symbol}`)?.price)),
    recentEvents,
  };
}
export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;
