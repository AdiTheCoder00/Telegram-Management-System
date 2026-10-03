import { DELIVERY_STATUSES } from "@/lib/constants";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getDeliveryLogs, getHistory } from "@/lib/services/history";
import { historyQuerySchema } from "@/lib/validation";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/app-shell";
import { HistoryView } from "@/components/history/history-view";
import { AutoRefresh } from "@/components/auto-refresh";
import { AnalyticsView } from "@/components/history/analytics-view";
import { getAnalytics } from "@/lib/services/analytics";

export const metadata = { title: "Alert history" };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = (await getCurrentUser())!;
  const sp = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => v)) as Record<string, string>;
  const tab = sp.tab === "deliveries" ? "deliveries" : sp.tab === "analytics" ? "analytics" : "triggers";

  const parsed = historyQuerySchema.safeParse(sp);
  const q = parsed.success ? parsed.data : historyQuerySchema.parse({});
  // "to" from a date input means the end of that day
  if (q.to && sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to)) q.to = new Date(q.to.getTime() + 86_399_999);

  const dq = z.object({ status: z.enum(DELIVERY_STATUSES).optional(), page: z.coerce.number().int().min(1).default(1) }).safeParse(sp);

  const [history, deliveries, symbols] = await Promise.all([
    tab === "triggers" ? getHistory(user.id, q) : null,
    tab === "deliveries"
      ? getDeliveryLogs(user.id, { status: dq.success ? dq.data.status : undefined, page: dq.success ? dq.data.page : 1, pageSize: 25 })
      : null,
    db.alertEvent.findMany({ where: { userId: user.id }, distinct: ["symbol"], select: { symbol: true }, orderBy: { symbol: "asc" } }),
  ]);
  const analytics = tab === "analytics" ? await getAnalytics(user.id, user.timezone) : null;

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title="Alert history"
        description="Every trigger is recorded with the price that fired it and what happened to the Telegram message."
      />
      <HistoryView
        tab={tab}
        history={history ? JSON.parse(JSON.stringify(history)) : null}
        deliveries={deliveries ? JSON.parse(JSON.stringify(deliveries)) : null}
        symbols={symbols.map((s) => s.symbol)}
        params={sp}
        analytics={analytics ? <AnalyticsView a={analytics} /> : null}
      />
    </>
  );
}
