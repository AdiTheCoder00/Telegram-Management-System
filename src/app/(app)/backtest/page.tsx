import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/app-shell";
import { BacktestView } from "@/components/backtest/backtest-view";
import { listBacktests } from "@/lib/services/backtests";

export const metadata = { title: "Backtest" };

export default async function BacktestPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = (await getCurrentUser())!;
  const sp = await searchParams;
  const [alerts, runs] = await Promise.all([
    db.alert.findMany({
      where: { userId: user.id, kind: "CONDITIONS" },
      select: { id: true, name: true, symbol: true, timeframe: true, dataProvider: true, configVersion: true },
      orderBy: { createdAt: "desc" },
    }),
    listBacktests(user.id),
  ]);
  return (
    <>
      <PageHeader
        title="Backtest"
        description="Replay an alert's conditions over history with the same engine the live alerts use — candle by candle, no look-ahead."
      />
      <BacktestView alerts={alerts} initialRuns={JSON.parse(JSON.stringify(runs))} initialAlertId={sp.alert ?? null} />
    </>
  );
}
