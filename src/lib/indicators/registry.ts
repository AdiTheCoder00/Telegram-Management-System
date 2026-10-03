import type { Candle } from "@/lib/market/candles";
import * as I from "@/lib/indicators";
import type { Series } from "@/lib/indicators";
import { candleMetric } from "@/lib/market/patterns";

export type IndicatorGroup = "trend" | "momentum" | "volatility" | "volume" | "candle";

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  integer?: boolean;
}

export interface IndicatorDef {
  key: string;
  label: string;
  group: IndicatorGroup;
  params: ParamDef[];
  outputs: string[];
  defaultOutput: string;
  /** Number of candles needed before the first non-null value. */
  warmup: (p: Record<string, number>) => number;
  needsVolume?: boolean;
  compute: (c: Candle[], p: Record<string, number>) => Record<string, Series>;
}

const len = (key = "period", def = 14, label = "Length"): ParamDef => ({ key, label, default: def, min: 1, max: 500, integer: true });
const closes = (c: Candle[]) => c.map((x) => x.close);

export const INDICATORS: IndicatorDef[] = [
  // trend
  {
    key: "sma",
    label: "SMA",
    group: "trend",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.sma(closes(c), p.period) }),
  },
  {
    key: "ema",
    label: "EMA",
    group: "trend",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.ema(closes(c), p.period) }),
  },
  {
    key: "wma",
    label: "WMA",
    group: "trend",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.wma(closes(c), p.period) }),
  },
  {
    key: "vwap",
    label: "VWAP (daily, UTC)",
    group: "trend",
    params: [],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: () => 1,
    needsVolume: true,
    compute: (c) => ({ value: I.vwap(c) }),
  },
  {
    key: "supertrend",
    label: "Supertrend",
    group: "trend",
    params: [len("period", 10, "ATR length"), { key: "multiplier", label: "Multiplier", default: 3, min: 0.1, max: 20 }],
    outputs: ["value", "direction"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => I.supertrend(c, p.period, p.multiplier),
  },
  // momentum
  {
    key: "rsi",
    label: "RSI",
    group: "momentum",
    params: [len("period", 14)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period + 1,
    compute: (c, p) => ({ value: I.rsi(closes(c), p.period) }),
  },
  {
    key: "stoch",
    label: "Stochastic",
    group: "momentum",
    params: [len("k", 14, "%K length"), len("smooth", 3, "%K smoothing"), len("d", 3, "%D length")],
    outputs: ["k", "d"],
    defaultOutput: "k",
    warmup: (p) => p.k + p.smooth + p.d - 2,
    compute: (c, p) => I.stochastic(c, p.k, p.smooth, p.d),
  },
  {
    key: "stochrsi",
    label: "Stochastic RSI",
    group: "momentum",
    params: [len("rsi", 14, "RSI length"), len("stoch", 14, "Stoch length"), len("k", 3, "%K"), len("d", 3, "%D")],
    outputs: ["k", "d"],
    defaultOutput: "k",
    warmup: (p) => p.rsi + p.stoch + p.k + p.d - 2,
    compute: (c, p) => I.stochRsi(closes(c), p.rsi, p.stoch, p.k, p.d),
  },
  {
    key: "macd",
    label: "MACD",
    group: "momentum",
    params: [len("fast", 12, "Fast"), len("slow", 26, "Slow"), len("signal", 9, "Signal")],
    outputs: ["macd", "signal", "histogram"],
    defaultOutput: "macd",
    warmup: (p) => p.slow + p.signal - 1,
    compute: (c, p) => I.macd(closes(c), p.fast, p.slow, p.signal),
  },
  {
    key: "cci",
    label: "CCI",
    group: "momentum",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.cci(c, p.period) }),
  },
  {
    key: "willr",
    label: "Williams %R",
    group: "momentum",
    params: [len("period", 14)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.williamsR(c, p.period) }),
  },
  // volatility
  {
    key: "atr",
    label: "ATR",
    group: "volatility",
    params: [len("period", 14)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.atr(c, p.period) }),
  },
  {
    key: "bbands",
    label: "Bollinger Bands",
    group: "volatility",
    params: [len("period", 20), { key: "stddev", label: "Std devs", default: 2, min: 0.1, max: 10 }],
    outputs: ["upper", "middle", "lower"],
    defaultOutput: "middle",
    warmup: (p) => p.period,
    compute: (c, p) => I.bollinger(closes(c), p.period, p.stddev),
  },
  {
    key: "stddev",
    label: "Standard deviation",
    group: "volatility",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    compute: (c, p) => ({ value: I.stdev(closes(c), p.period) }),
  },
  // volume — never substituted: null when the provider has no volume
  {
    key: "volume",
    label: "Volume",
    group: "volume",
    params: [],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: () => 1,
    needsVolume: true,
    compute: (c) => ({ value: I.volumeSeries(c) }),
  },
  {
    key: "avgvolume",
    label: "Average volume",
    group: "volume",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period,
    needsVolume: true,
    compute: (c, p) => ({ value: I.sma(I.volumeSeries(c), p.period) }),
  },
  {
    key: "rvol",
    label: "Relative volume",
    group: "volume",
    params: [len("period", 20)],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period + 1,
    needsVolume: true,
    compute: (c, p) => {
      const v = I.volumeSeries(c);
      const base = I.priorAverage(v, p.period);
      return { value: v.map((x, i) => (x !== null && base[i] ? x / (base[i] as number) : null)) };
    },
  },
  {
    key: "volspike",
    label: "Volume spike (1 = yes)",
    group: "volume",
    params: [len("period", 20), { key: "multiplier", label: "× average", default: 2, min: 1, max: 100 }],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: (p) => p.period + 1,
    needsVolume: true,
    compute: (c, p) => {
      const v = I.volumeSeries(c);
      const base = I.priorAverage(v, p.period);
      return { value: v.map((x, i) => (x !== null && base[i] !== null ? (x > (base[i] as number) * p.multiplier ? 1 : 0) : null)) };
    },
  },
  // candle anatomy as numbers, so they can be compared like any indicator
  {
    key: "body_pct",
    label: "Body % of range",
    group: "candle",
    params: [],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: () => 1,
    compute: (c) => ({ value: c.map((x) => candleMetric(x, "body_pct")) }),
  },
  {
    key: "upper_wick_pct",
    label: "Upper wick % of range",
    group: "candle",
    params: [],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: () => 1,
    compute: (c) => ({ value: c.map((x) => candleMetric(x, "upper_wick_pct")) }),
  },
  {
    key: "lower_wick_pct",
    label: "Lower wick % of range",
    group: "candle",
    params: [],
    outputs: ["value"],
    defaultOutput: "value",
    warmup: () => 1,
    compute: (c) => ({ value: c.map((x) => candleMetric(x, "lower_wick_pct")) }),
  },
];

const BY_KEY = new Map(INDICATORS.map((d) => [d.key, d]));

export function getIndicator(key: string) {
  return BY_KEY.get(key);
}

/** Fills in defaults and validates parameter ranges. Throws with a readable message. */
export function resolveParams(def: IndicatorDef, given: Record<string, number> = {}) {
  const out: Record<string, number> = {};
  for (const p of def.params) {
    const v = given[p.key] ?? p.default;
    if (!Number.isFinite(v) || v < p.min || v > p.max) throw new Error(`${def.label}: ${p.label} must be between ${p.min} and ${p.max}`);
    if (p.integer && !Number.isInteger(v)) throw new Error(`${def.label}: ${p.label} must be a whole number`);
    out[p.key] = v;
  }
  for (const k of Object.keys(given)) if (!def.params.some((p) => p.key === k)) throw new Error(`${def.label}: unknown parameter "${k}"`);
  return out;
}

export function describeIndicator(key: string, params: Record<string, number> = {}, output?: string) {
  const def = BY_KEY.get(key);
  if (!def) return key;
  const p = def.params.map((d) => params[d.key] ?? d.default);
  const base = p.length ? `${def.label}(${p.join(",")})` : def.label;
  return output && output !== def.defaultOutput ? `${base}.${output}` : base;
}
