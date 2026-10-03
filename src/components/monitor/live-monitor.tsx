"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Activity } from "lucide-react";
import { Card } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertStatusBadge } from "@/components/status";
import { api } from "@/lib/client-api";
import type { MonitorSnapshot } from "@/lib/services/monitor";
import type { ChartCandle } from "@/components/charts/candle-chart";
import { cn, formatPrice } from "@/lib/utils";

const CandleChart = dynamic(() => import("@/components/charts/candle-chart").then((m) => m.CandleChart), { ssr: false });

type Snap = Omit<MonitorSnapshot, "alerts"> & {
  alerts: (Omit<MonitorSnapshot["alerts"][number], "lastEvaluatedAt" | "lastTriggeredAt" | "priceAt"> & {
    lastEvaluatedAt: string | null;
    lastTriggeredAt: string | null;
    priceAt: string | null;
  })[];
};

const STATE_TONE: Record<string, string> = {
  FRESH: "text-up",
  STALE: "text-signal",
  INSUFFICIENT_HISTORY: "text-signal",
  INVALID: "text-down",
  ERROR: "text-down",
};

function ago(iso: string | null) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

/** Live monitor: alert states over SSE + a live candle chart for the selected alert. */
export function LiveMonitor() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [connected, setConnected] = useState(false);
  const [chartAlert, setChartAlert] = useState<string>("");
  const [chart, setChart] = useState<{ key: string; candles: ChartCandle[]; freshness: string | null } | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      setSnap(JSON.parse((e as MessageEvent).data));
      setConnected(true);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  const selected = snap?.alerts.find((a) => a.id === chartAlert) ?? snap?.alerts[0] ?? null;
  const tf = selected?.kind === "CONDITIONS" ? selected.timeframe : "1m";
  const key = selected ? `${selected.dataProvider}|${selected.symbol}|${tf}` : "";

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const load = async () => {
      try {
        const qs = new URLSearchParams({ provider: selected.dataProvider, symbol: selected.symbol, timeframe: tf, bars: "200" });
        const r = await api<{ candles: ChartCandle[]; freshness: { state: string } | null }>(`/api/candles?${qs}`);
        if (live) setChart({ key, candles: r.candles, freshness: r.freshness?.state ?? null });
      } catch {
        /* keep the last chart */
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the chart target changes
  }, [key]);

  const lines = useMemo(
    () => (selected && selected.kind === "PRICE" && selected.targetPrice ? [{ price: selected.targetPrice, title: "target" }] : []),
    [selected],
  );
  const shownChart = chart?.key === key ? chart : null;
  const workerOk = snap?.workerAgeSec !== null && snap?.workerAgeSec !== undefined && snap.workerAgeSec < 60;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <Activity className="size-4" /> Live monitor
        </h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", connected ? "bg-up" : "bg-muted-foreground")} />{" "}
            {connected ? "streaming" : "connecting…"}
          </span>
          <span className={cn(workerOk ? "" : "text-down")}>
            worker {snap?.workerAgeSec === null ? "not running" : snap ? `seen ${snap.workerAgeSec}s ago` : "…"}
          </span>
        </div>
      </div>

      {!snap ? (
        <p className="px-5 py-8 text-sm text-muted-foreground">Connecting to the live stream…</p>
      ) : snap.alerts.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted-foreground">
          No live alerts.{" "}
          <Link href="/alerts/new" className="underline">
            Create one
          </Link>{" "}
          to see it monitored here.
        </p>
      ) : (
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="max-h-[420px] divide-y overflow-auto border-b lg:border-r lg:border-b-0">
            {snap.alerts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setChartAlert(a.id)}
                  className={cn("w-full px-5 py-2.5 text-left transition-colors hover:bg-muted/40", selected?.id === a.id && "bg-muted/50")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <AlertStatusBadge status={a.status} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular">
                    <span className="font-semibold text-foreground">{a.symbol}</span>
                    <span>{a.price !== null ? formatPrice(a.price) : "no price"}</span>
                    {a.kind === "CONDITIONS" && <span>{a.timeframe}</span>}
                    {a.marketDataState && (
                      <span className={STATE_TONE[a.marketDataState]}>{a.marketDataState.toLowerCase().replace("_", " ")}</span>
                    )}
                    <span>evaluated {ago(a.lastEvaluatedAt)}</span>
                    {!a.armed && a.status === "ACTIVE" && <span>waiting to re-arm</span>}
                  </div>
                  {a.lastEvaluationNote && <div className="mt-0.5 truncate text-xs text-signal">{a.lastEvaluationNote}</div>}
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 p-4">
            {selected && (
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium">
                  {selected.symbol} {tf}{" "}
                  <span className="text-xs font-normal text-muted-foreground">via {selected.dataProvider} (UTC)</span>
                </div>
                <div className="flex items-center gap-2">
                  {shownChart?.freshness && (
                    <span className={cn("text-xs", STATE_TONE[shownChart.freshness] ?? "text-up")}>
                      {shownChart.freshness.toLowerCase()}
                    </span>
                  )}
                  <Select value={selected.id} onValueChange={setChartAlert}>
                    <SelectTrigger className="h-8 w-44 text-xs" aria-label="Chart alert">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {snap.alerts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {shownChart ? (
              shownChart.candles.length ? (
                <CandleChart candles={shownChart.candles} lines={lines} height={320} follow />
              ) : (
                <p className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">No candles yet for this feed.</p>
              )
            ) : (
              <p className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">Loading chart…</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
