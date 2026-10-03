"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

export interface ChartCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  state?: string;
}

export interface ChartMarker {
  time: number; // candle open time (ms)
  text?: string;
  position?: "aboveBar" | "belowBar";
  color?: string;
}

export interface ChartLine {
  price: number;
  title: string;
  color?: string;
}

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.classList.contains("dark");
  return {
    text: dark ? "#a1a1aa" : "#52525b",
    grid: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
    up: v("--color-up", "#16a34a"),
    down: v("--color-down", "#dc2626"),
  };
}

/**
 * Candlestick chart (lightweight-charts) for live monitoring and backtest review. Times are shown in UTC — the
 * same clock the engine uses for candle boundaries. Forming candles are drawn semi-transparent.
 */
export function CandleChart({
  candles,
  markers = [],
  lines = [],
  height = 360,
  follow = false,
}: {
  candles: ChartCandle[];
  markers?: ChartMarker[];
  lines?: ChartLine[];
  height?: number;
  /** Keep the newest candle in view as data updates (live mode). */
  follow?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLines = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>[]>([]);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = themeColors();
    const ch = createChart(el.current, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.text, fontSize: 11 },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 0 },
    });
    const s = ch.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    chart.current = ch;
    series.current = s;
    markerApi.current = createSeriesMarkers(s, []);
    fitted.current = false;
    return () => {
      ch.remove();
      chart.current = null;
      series.current = null;
      markerApi.current = null;
      priceLines.current = [];
    };
  }, [height]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const c = themeColors();
    s.setData(
      candles.map((k) => ({
        time: sec(k.openTime),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        ...(k.state === "FORMING"
          ? { color: `${k.close >= k.open ? c.up : c.down}88`, wickColor: `${k.close >= k.open ? c.up : c.down}88` }
          : {}),
      })),
    );
    if (!fitted.current && candles.length) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    } else if (follow) chart.current?.timeScale().scrollToRealTime();
  }, [candles, follow]);

  useEffect(() => {
    const m: SeriesMarker<Time>[] = markers
      .map((k) => ({
        time: sec(k.time),
        position: k.position ?? ("belowBar" as const),
        shape: k.position === "aboveBar" ? ("arrowDown" as const) : ("arrowUp" as const),
        color: k.color ?? "#f59e0b",
        text: k.text,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    markerApi.current?.setMarkers(m);
  }, [markers]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of priceLines.current) s.removePriceLine(l);
    priceLines.current = lines.map((l) =>
      s.createPriceLine({
        price: l.price,
        title: l.title,
        color: l.color ?? "#f59e0b",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
      }),
    );
  }, [lines]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

// Re-exported so other charts (e.g. equity curves) can share the setup.
export { LineSeries };
