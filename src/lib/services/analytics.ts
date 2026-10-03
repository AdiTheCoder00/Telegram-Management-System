import { db } from "@/lib/db";

/**
 * Personal analytics (M19) over real (non-test) triggers and their notifications: activity per day and hour,
 * which alerts and symbols fire most, delivery reliability and latency. All aggregation happens in SQL.
 */
export async function getAnalytics(userId: string, timezone: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);

  const [perDay, perHour, byAlert, bySymbol, deliveries, latency, states] = await Promise.all([
    db.$queryRaw<{ day: string; n: bigint }[]>`
      SELECT to_char(("triggeredAt" AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day, count(*) AS n
      FROM "AlertEvent" WHERE "userId" = ${userId} AND NOT "isTest" AND "triggeredAt" >= ${since}
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ hour: number; n: bigint }[]>`
      SELECT extract(hour FROM "triggeredAt" AT TIME ZONE ${timezone})::int AS hour, count(*) AS n
      FROM "AlertEvent" WHERE "userId" = ${userId} AND NOT "isTest" AND "triggeredAt" >= ${since}
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ alertId: string | null; name: string; n: bigint; last: Date }[]>`
      SELECT "alertId", max("alertName") AS name, count(*) AS n, max("triggeredAt") AS last
      FROM "AlertEvent" WHERE "userId" = ${userId} AND NOT "isTest" AND "triggeredAt" >= ${since}
      GROUP BY "alertId" ORDER BY n DESC LIMIT 10`,
    db.$queryRaw<{ symbol: string; n: bigint }[]>`
      SELECT "symbol", count(*) AS n FROM "AlertEvent"
      WHERE "userId" = ${userId} AND NOT "isTest" AND "triggeredAt" >= ${since}
      GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    db.$queryRaw<{ status: string; n: bigint }[]>`
      SELECT "status"::text AS status, count(*) AS n FROM "TelegramDelivery"
      WHERE "userId" = ${userId} AND NOT "isTest" AND "createdAt" >= ${since} GROUP BY 1`,
    db.$queryRaw<{ p50: number | null; p95: number | null; max: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
             max(ms) AS max
      FROM (SELECT extract(epoch FROM (d."sentAt" - e."triggeredAt")) * 1000 AS ms
            FROM "TelegramDelivery" d JOIN "AlertEvent" e ON e."id" = d."alertEventId"
            WHERE d."userId" = ${userId} AND NOT d."isTest" AND d."sentAt" IS NOT NULL AND d."createdAt" >= ${since}) t`,
    db.alert.groupBy({
      by: ["marketDataState"],
      where: { userId, kind: "CONDITIONS", status: { in: ["ACTIVE", "COOLDOWN"] } },
      _count: true,
    }),
  ]);

  const n = (x: bigint) => Number(x);
  const byStatus = Object.fromEntries(deliveries.map((d) => [d.status, n(d.n)]));
  const sent = byStatus.SENT ?? 0;
  const failed = (byStatus.FAILED ?? 0) + (byStatus.DEAD_LETTER ?? 0);
  const total = perDay.reduce((a, d) => a + n(d.n), 0);

  // Fill missing days so the chart has a continuous axis.
  const daySeries: { day: string; n: number }[] = [];
  const map = new Map(perDay.map((d) => [d.day, n(d.n)]));
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let i = days - 1; i >= 0; i--) {
    const day = fmt.format(new Date(Date.now() - i * 86_400_000));
    daySeries.push({ day, n: map.get(day) ?? 0 });
  }
  const hourMap = new Map(perHour.map((h) => [h.hour, n(h.n)]));

  return {
    days,
    timezone,
    totals: { triggers: total, perDayAvg: Math.round((total / days) * 10) / 10 },
    perDay: daySeries,
    perHour: [...Array(24)].map((_, h) => ({ hour: h, n: hourMap.get(h) ?? 0 })),
    byAlert: byAlert.map((a) => ({ alertId: a.alertId, name: a.name, n: n(a.n), last: a.last })),
    bySymbol: bySymbol.map((s) => ({ symbol: s.symbol, n: n(s.n) })),
    delivery: {
      byStatus,
      successRate: sent + failed ? Math.round((sent / (sent + failed)) * 1000) / 10 : null,
      latencyMs: { p50: latency[0]?.p50 ?? null, p95: latency[0]?.p95 ?? null, max: latency[0]?.max ?? null },
    },
    marketData: states.map((s) => ({ state: s.marketDataState ?? "NOT_EVALUATED", n: s._count })),
  };
}
export type Analytics = Awaited<ReturnType<typeof getAnalytics>>;
