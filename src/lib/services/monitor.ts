import { db } from "@/lib/db";
import { latestQuotesFor } from "@/lib/engine/quotes";

/**
 * Live monitor snapshot (M16): what every live alert is doing right now — status, market-data state, why it is
 * waiting, last price and trigger — plus worker liveness. Streamed to the dashboard over SSE.
 */
export async function monitorSnapshot(userId: string) {
  const [alerts, heartbeat, lastEvent] = await Promise.all([
    db.alert.findMany({
      where: { userId, status: { in: ["ACTIVE", "COOLDOWN"] } },
      select: {
        id: true,
        name: true,
        symbol: true,
        dataProvider: true,
        kind: true,
        timeframe: true,
        status: true,
        marketDataState: true,
        lastEvaluationNote: true,
        lastEvaluatedAt: true,
        lastTriggeredAt: true,
        triggerCount: true,
        armed: true,
        targetPrice: true,
        conditionType: true,
      },
      orderBy: { name: "asc" },
      take: 200,
    }),
    db.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } }),
    db.alertEvent.findFirst({
      where: { userId, isTest: false },
      orderBy: { triggeredAt: "desc" },
      select: { id: true, triggeredAt: true, alertName: true },
    }),
  ]);
  const quotes = await latestQuotesFor(
    alerts.map((a) => ({ provider: a.dataProvider, symbol: a.symbol })),
    userId,
  );
  const now = Date.now();
  return {
    at: new Date(now).toISOString(),
    workerAgeSec: heartbeat ? Math.round((now - heartbeat.lastSeenAt.getTime()) / 1000) : null,
    lastEvent,
    alerts: alerts.map((a) => {
      const q = quotes.get(`${a.dataProvider}:${a.symbol}`);
      return { ...a, price: q?.price ?? null, priceAt: q?.updatedAt ?? null };
    }),
  };
}
export type MonitorSnapshot = Awaited<ReturnType<typeof monitorSnapshot>>;
