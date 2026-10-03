import type { Candle } from "@/lib/market/candles";

/**
 * Technical indicator engine.
 *
 * Every indicator is a pure, deterministic, CAUSAL function of a candle series: the value at index i depends
 * only on candles[0..i]. Live alerts, the simulator, backtests and charts all call these same functions, so
 * results cannot drift between modes. Values are `null` until the indicator's warm-up is satisfied.
 * Bump INDICATOR_ENGINE_VERSION whenever a calculation changes (stored with trigger evidence and backtests).
 */
export const INDICATOR_ENGINE_VERSION = "1.0.0";

export type Series = (number | null)[];
export type Source = "open" | "high" | "low" | "close" | "hl2" | "hlc3" | "ohlc4";

export const src = (c: Candle, s: Source = "close") => {
  switch (s) {
    case "open":
      return c.open;
    case "high":
      return c.high;
    case "low":
      return c.low;
    case "close":
      return c.close;
    case "hl2":
      return (c.high + c.low) / 2;
    case "hlc3":
      return (c.high + c.low + c.close) / 3;
    case "ohlc4":
      return (c.open + c.high + c.low + c.close) / 4;
  }
};

// ─── primitive series helpers (operate on number|null arrays, causal) ────────

export function sma(values: Series, n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0; // consecutive non-null values in window
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > n) {
      sum -= values[i - n] as number;
      count = n;
    }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values (standard), alpha = 2/(n+1). */
export function ema(values: Series, n: number): Series {
  return expSmooth(values, n, 2 / (n + 1));
}

/** Wilder's smoothing (RMA), alpha = 1/n, seeded with the SMA of the first n values. */
export function rma(values: Series, n: number): Series {
  return expSmooth(values, n, 1 / n);
}

function expSmooth(values: Series, n: number, alpha: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let prev: number | null = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      if (prev === null) {
        seedSum = 0;
        seedCount = 0;
      }
      continue;
    }
    if (prev === null) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function wma(values: Series, n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const v = values[i - n + 1 + k];
      if (v === null) {
        ok = false;
        break;
      }
      s += v * (k + 1);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

/** Population standard deviation over n values. */
export function stdev(values: Series, n: number): Series {
  const mean = sma(values, n);
  const out: Series = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    const m = mean[i];
    if (m === null) continue;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += ((values[k] as number) - m) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function highest(values: number[], i: number, n: number) {
  let h = -Infinity;
  for (let k = i - n + 1; k <= i; k++) h = Math.max(h, values[k]);
  return h;
}
function lowest(values: number[], i: number, n: number) {
  let l = Infinity;
  for (let k = i - n + 1; k <= i; k++) l = Math.min(l, values[k]);
  return l;
}

// ─── indicators ───────────────────────────────────────────────────────────────

export function rsi(closes: number[], n = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  const value = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[n] = value();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

export function trueRange(c: Candle[]): Series {
  return c.map((x, i) =>
    i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
  );
}

export function atr(c: Candle[], n = 14): Series {
  return rma(trueRange(c), n);
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line: Series = closes.map((_, i) => (f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null));
  const sig = ema(line, signal);
  const hist: Series = line.map((v, i) => (v !== null && sig[i] !== null ? v - (sig[i] as number) : null));
  return { macd: line, signal: sig, histogram: hist };
}

export function bollinger(closes: number[], n = 20, mult = 2) {
  const mid = sma(closes, n);
  const sd = stdev(closes, n);
  return {
    middle: mid,
    upper: mid.map((m, i) => (m !== null && sd[i] !== null ? m + mult * (sd[i] as number) : null)),
    lower: mid.map((m, i) => (m !== null && sd[i] !== null ? m - mult * (sd[i] as number) : null)),
  };
}

/** Slow stochastic: %K = SMA(raw %K, smooth), %D = SMA(%K, d). */
export function stochastic(c: Candle[], kLen = 14, smooth = 3, dLen = 3) {
  const highs = c.map((x) => x.high);
  const lows = c.map((x) => x.low);
  const raw: Series = c.map((x, i) => {
    if (i < kLen - 1) return null;
    const hh = highest(highs, i, kLen);
    const ll = lowest(lows, i, kLen);
    return hh === ll ? 50 : (100 * (x.close - ll)) / (hh - ll);
  });
  const k = sma(raw, smooth);
  return { k, d: sma(k, dLen) };
}

export function stochRsi(closes: number[], rsiLen = 14, stochLen = 14, kLen = 3, dLen = 3) {
  const r = rsi(closes, rsiLen);
  const raw: Series = r.map((v, i) => {
    if (v === null || i < stochLen - 1) return null;
    const window = r.slice(i - stochLen + 1, i + 1);
    if (window.some((x) => x === null)) return null;
    const w = window as number[];
    const hh = Math.max(...w);
    const ll = Math.min(...w);
    return hh === ll ? 50 : (100 * (v - ll)) / (hh - ll);
  });
  const k = sma(raw, kLen);
  return { k, d: sma(k, dLen) };
}

export function cci(c: Candle[], n = 20): Series {
  const tp = c.map((x) => (x.high + x.low + x.close) / 3);
  const mean = sma(tp, n);
  return tp.map((v, i) => {
    const m = mean[i];
    if (m === null) return null;
    let dev = 0;
    for (let k = i - n + 1; k <= i; k++) dev += Math.abs(tp[k] - m);
    dev /= n;
    return dev === 0 ? 0 : (v - m) / (0.015 * dev);
  });
}

export function williamsR(c: Candle[], n = 14): Series {
  const highs = c.map((x) => x.high);
  const lows = c.map((x) => x.low);
  return c.map((x, i) => {
    if (i < n - 1) return null;
    const hh = highest(highs, i, n);
    const ll = lowest(lows, i, n);
    return hh === ll ? -50 : (-100 * (hh - x.close)) / (hh - ll);
  });
}

/**
 * VWAP anchored to the UTC day (resets at 00:00 UTC). Requires volume; returns nulls when volume is
 * unavailable rather than substituting another volume type.
 */
export function vwap(c: Candle[]): Series {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return c.map((x) => {
    if (x.volume === null || x.volumeType === "UNAVAILABLE") return null;
    const d = Math.floor(x.openTime / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((x.high + x.low + x.close) / 3) * x.volume;
    vol += x.volume;
    return vol === 0 ? null : pv / vol;
  });
}

/** Supertrend (ATR bands on hl2). direction: 1 = uptrend (line below price), -1 = downtrend. */
export function supertrend(c: Candle[], n = 10, mult = 3) {
  const a = atr(c, n);
  const value: Series = new Array(c.length).fill(null);
  const direction: Series = new Array(c.length).fill(null);
  let upper = 0;
  let lower = 0;
  let dir = 1;
  let started = false;
  for (let i = 0; i < c.length; i++) {
    const av = a[i];
    if (av === null) continue;
    const mid = (c[i].high + c[i].low) / 2;
    const basicUpper = mid + mult * av;
    const basicLower = mid - mult * av;
    if (!started) {
      upper = basicUpper;
      lower = basicLower;
      dir = c[i].close >= mid ? 1 : -1;
      started = true;
    } else {
      const prevClose = c[i - 1].close;
      upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
      lower = basicLower > lower || prevClose < lower ? basicLower : lower;
      if (dir === -1 && c[i].close > upper) dir = 1;
      else if (dir === 1 && c[i].close < lower) dir = -1;
    }
    value[i] = dir === 1 ? lower : upper;
    direction[i] = dir;
  }
  return { value, direction };
}

export function volumeSeries(c: Candle[]): Series {
  return c.map((x) => (x.volumeType === "UNAVAILABLE" ? null : x.volume));
}

/** Average of the previous n volumes (excludes the current bar, so a spike doesn't dilute its own baseline). */
export function priorAverage(values: Series, n: number): Series {
  const avg = sma(values, n);
  return values.map((_, i) => (i === 0 ? null : avg[i - 1]));
}
