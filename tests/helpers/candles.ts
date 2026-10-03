import type { Candle, VolumeType } from "@/lib/market/candles";
import { bucketEnd, timeframeMs, type Timeframe } from "@/lib/market/timeframes";

/** Builds CLOSED candles from close prices (open = previous close), starting at `start`. */
export function candlesFromCloses(
  closes: number[],
  tf: Timeframe = "5m",
  start = Date.UTC(2026, 9, 5, 0, 0),
  opts: { volume?: (i: number) => number | null; volumeType?: VolumeType; spread?: number } = {},
): Candle[] {
  const spread = opts.spread ?? 0.5;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const openTime = start + i * timeframeMs(tf);
    const vol = opts.volume ? opts.volume(i) : 100;
    return {
      openTime,
      closeTime: bucketEnd(openTime, tf),
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: vol,
      volumeType: vol === null ? "UNAVAILABLE" : (opts.volumeType ?? "REAL"),
      state: "CLOSED",
    };
  });
}

export function candle(over: Partial<Candle> & Pick<Candle, "open" | "high" | "low" | "close">, openTime = Date.UTC(2026, 9, 5)): Candle {
  return { openTime, closeTime: openTime + 300_000, volume: 100, volumeType: "REAL", state: "CLOSED", ...over };
}
