"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/client-api";
import type { BacktestConfig, BacktestTrigger } from "@/lib/backtest/engine";
import type { ChartCandle } from "@/components/charts/candle-chart";

const CandleChart = dynamic(() => import("@/components/charts/candle-chart").then((m) => m.CandleChart), { ssr: false });

/** Price chart of the backtest range with a marker on every trigger candle. */
export function BacktestChart({ run }: { run: { id: string; config: BacktestConfig; triggers?: BacktestTrigger[] } }) {
  const [loaded, setLoaded] = useState<{ key: string; candles?: ChartCandle[]; error?: string } | null>(null);
  const c = run.config;
  const key = `${c.dataProvider}|${c.symbol}|${c.timeframe}|${c.from}|${c.to}`;

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ provider: c.dataProvider, symbol: c.symbol, timeframe: c.timeframe, from: c.from, to: c.to });
    api<{ candles: ChartCandle[] }>(`/api/candles?${qs}`)
      .then((r) => live && setLoaded({ key, candles: r.candles }))
      .catch((err) => live && setLoaded({ key, error: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [key, c.dataProvider, c.symbol, c.timeframe, c.from, c.to]);
  const current = loaded?.key === key ? loaded : null;
  const candles = current?.candles ?? null;
  const error = current?.error ?? null;

  const markers = useMemo(() => (run.triggers ?? []).map((t) => ({ time: Date.parse(t.candleOpenTime), text: `#${t.n}` })), [run.triggers]);

  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold">
        {c.symbol} {c.timeframe} · triggers <span className="text-xs font-normal text-muted-foreground">(UTC)</span>
      </h2>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !candles ? (
        <p className="flex h-[360px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading candles…
        </p>
      ) : (
        <CandleChart candles={candles} markers={markers} />
      )}
    </Card>
  );
}
