import type { Candle } from "@/lib/market/candles";
import type { Timeframe } from "@/lib/market/timeframes";
import { getIndicator, resolveParams } from "@/lib/indicators/registry";
import { EvaluationContext, type EvaluationMode } from "@/lib/conditions/evaluate";
import { timeframesUsed, type ConditionNode, type Operand } from "@/lib/conditions/types";

/**
 * Fixed evaluation windows — the live/backtest consistency guarantee.
 *
 * Exponential indicators (EMA, RSI, ATR, MACD …) depend on how much history they are seeded with. If live
 * alerts used "whatever the provider returned" and backtests used years of history, the same bar could get
 * different values. So every evaluation — live, simulator, backtest — uses EXACTLY the last L bars of each
 * timeframe ending at the bar that is current at `asOf`. L is a pure function of the condition tree:
 *
 *   L(tf) = clamp(4 × largest warm-up of any indicator on tf, ≥ 3, ≤ 1000)   (+ pattern look-back)
 *
 * With the same candles, live and backtest therefore produce identical indicator values and decisions.
 * If fewer than L bars exist the evaluation reports INSUFFICIENT_HISTORY instead of guessing.
 */
export const LOOKBACK_MULTIPLIER = 4;
export const MIN_BARS = 3;
export const MAX_BARS = 1000;

function operandWarmup(o: Operand): number {
  if (o.kind !== "indicator") return 2; // price: current + previous (crossings)
  const def = getIndicator(o.indicator);
  if (!def) return 2;
  try {
    return def.warmup(resolveParams(def, o.params)) + 1;
  } catch {
    return 2;
  }
}

export function lookbackBars(root: ConditionNode, base: Timeframe): Map<Timeframe, number> {
  const need = new Map<Timeframe, number>(timeframesUsed(root, base).map((tf) => [tf, MIN_BARS]));
  const bump = (tf: Timeframe, bars: number) => need.set(tf, Math.min(MAX_BARS, Math.max(need.get(tf) ?? MIN_BARS, bars)));
  const visit = (n: ConditionNode) => {
    if (n.type === "group") n.children.forEach(visit);
    else if (n.type === "not") visit(n.child);
    else if (n.type === "compare") {
      for (const o of [n.left, n.right]) {
        if (o.kind === "value") continue;
        bump(o.timeframe ?? base, operandWarmup(o) * (o.kind === "indicator" ? LOOKBACK_MULTIPLIER : 1));
      }
    } else if (n.type === "pattern") bump(n.timeframe ?? base, (n.bars ?? 3) + 2);
  };
  visit(root);
  return need;
}

/** Index of the bar that is "current" at asOf for a timeframe (see EvaluationContext). */
function currentIndex(c: Candle[], asOf: number, forming: boolean) {
  let ans = -1;
  let lo = 0;
  let hi = c.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((forming ? c[mid].openTime : c[mid].closeTime) <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface WindowResult {
  ctx: EvaluationContext | null;
  /** Timeframes that did not have the full window available. */
  insufficient: { timeframe: Timeframe; have: number; need: number }[];
  windows: Partial<Record<Timeframe, { from: number; to: number; bars: number }>>;
}

/**
 * Builds an EvaluationContext over exactly-L-bar windows. `series` may contain more history (and, for
 * backtests, future candles) — only bars up to the current one at `asOf` are ever included.
 */
export function buildWindowContext(args: {
  symbol: string;
  baseTimeframe: Timeframe;
  mode: EvaluationMode;
  asOf: number;
  tree: ConditionNode;
  series: Partial<Record<Timeframe, Candle[]>>;
  lookback?: Map<Timeframe, number>;
}): WindowResult {
  const lookback = args.lookback ?? lookbackBars(args.tree, args.baseTimeframe);
  const windowed: Partial<Record<Timeframe, Candle[]>> = {};
  const insufficient: WindowResult["insufficient"] = [];
  const windows: WindowResult["windows"] = {};
  for (const [tf, need] of lookback) {
    const all = args.series[tf] ?? [];
    const forming = tf === args.baseTimeframe && args.mode === "EVERY_TICK";
    const i = currentIndex(all, args.asOf, forming);
    const have = i + 1;
    if (have < need) {
      insufficient.push({ timeframe: tf, have: Math.max(0, have), need });
      continue;
    }
    const slice = all.slice(i - need + 1, i + 1);
    windowed[tf] = slice;
    windows[tf] = { from: slice[0].openTime, to: slice[slice.length - 1].closeTime, bars: slice.length };
  }
  if (insufficient.length) return { ctx: null, insufficient, windows };
  return {
    ctx: new EvaluationContext({
      symbol: args.symbol,
      baseTimeframe: args.baseTimeframe,
      mode: args.mode,
      asOf: args.asOf,
      series: windowed,
    }),
    insufficient,
    windows,
  };
}
