import type { Candle } from "@/lib/market/candles";

/**
 * Candle patterns and volume patterns (M11). Each evaluates bar `i` using only bars ≤ i.
 * Returns null when the pattern cannot be evaluated (not enough bars, zero-range candle, missing volume) —
 * callers treat null as "not satisfied, insufficient data", never as true.
 * Definitions are documented in docs/candle-semantics.md.
 */
export const CANDLE_PATTERNS = [
  "bullish",
  "bearish",
  "doji",
  "bullish_engulfing",
  "bearish_engulfing",
  "hammer",
  "shooting_star",
  "inside_bar",
  "outside_bar",
  "higher_high",
  "higher_low",
  "lower_high",
  "lower_low",
  "volume_increasing",
  "volume_decreasing",
] as const;
export type CandlePattern = (typeof CANDLE_PATTERNS)[number];

export const PATTERN_LABELS: Record<CandlePattern, string> = {
  bullish: "Bullish candle",
  bearish: "Bearish candle",
  doji: "Doji",
  bullish_engulfing: "Bullish engulfing",
  bearish_engulfing: "Bearish engulfing",
  hammer: "Hammer",
  shooting_star: "Shooting star",
  inside_bar: "Inside bar",
  outside_bar: "Outside bar",
  higher_high: "Higher high",
  higher_low: "Higher low",
  lower_high: "Lower high",
  lower_low: "Lower low",
  volume_increasing: "Volume increasing",
  volume_decreasing: "Volume decreasing",
};

const range = (c: Candle) => c.high - c.low;
const body = (c: Candle) => Math.abs(c.close - c.open);
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;

export function candleMetric(c: Candle, metric: "body_pct" | "upper_wick_pct" | "lower_wick_pct"): number | null {
  const r = range(c);
  if (r <= 0) return null;
  const v = metric === "body_pct" ? body(c) : metric === "upper_wick_pct" ? upperWick(c) : lowerWick(c);
  return (v / r) * 100;
}

export interface PatternOptions {
  /** Doji: body at most this % of the range (default 10). */
  dojiMaxBodyPct?: number;
  /** Volume increasing/decreasing: number of consecutive bars (default 3). */
  bars?: number;
}

export function matchPattern(candles: Candle[], i: number, p: CandlePattern, o: PatternOptions = {}): boolean | null {
  const c = candles[i];
  if (!c) return null;
  const prev = i > 0 ? candles[i - 1] : undefined;
  const needPrev = (f: (prev: Candle) => boolean) => (prev ? f(prev) : null);
  switch (p) {
    case "bullish":
      return c.close > c.open;
    case "bearish":
      return c.close < c.open;
    case "doji":
      return range(c) > 0 ? (body(c) / range(c)) * 100 <= (o.dojiMaxBodyPct ?? 10) : null;
    case "bullish_engulfing":
      return needPrev((q) => q.close < q.open && c.close > c.open && c.open <= q.close && c.close >= q.open && body(c) > body(q));
    case "bearish_engulfing":
      return needPrev((q) => q.close > q.open && c.close < c.open && c.open >= q.close && c.close <= q.open && body(c) > body(q));
    case "hammer": {
      // Small body in the upper part of the range, long lower wick (≥ 2× body), short upper wick (≤ body).
      if (range(c) <= 0) return null;
      const b = Math.max(body(c), range(c) * 0.01);
      return lowerWick(c) >= 2 * b && upperWick(c) <= b;
    }
    case "shooting_star": {
      if (range(c) <= 0) return null;
      const b = Math.max(body(c), range(c) * 0.01);
      return upperWick(c) >= 2 * b && lowerWick(c) <= b;
    }
    case "inside_bar":
      return needPrev((q) => c.high < q.high && c.low > q.low);
    case "outside_bar":
      return needPrev((q) => c.high > q.high && c.low < q.low);
    case "higher_high":
      return needPrev((q) => c.high > q.high);
    case "higher_low":
      return needPrev((q) => c.low > q.low);
    case "lower_high":
      return needPrev((q) => c.high < q.high);
    case "lower_low":
      return needPrev((q) => c.low < q.low);
    case "volume_increasing":
    case "volume_decreasing": {
      const n = o.bars ?? 3;
      if (i < n) return null;
      const vols: number[] = [];
      for (let k = i - n; k <= i; k++) {
        const v = candles[k].volumeType === "UNAVAILABLE" ? null : candles[k].volume;
        if (v === null) return null; // never substitute a different volume type
        vols.push(v);
      }
      for (let k = 1; k < vols.length; k++) {
        if (p === "volume_increasing" ? vols[k] <= vols[k - 1] : vols[k] >= vols[k - 1]) return false;
      }
      return true;
    }
  }
}

export function patternNeedsVolume(p: CandlePattern) {
  return p === "volume_increasing" || p === "volume_decreasing";
}
