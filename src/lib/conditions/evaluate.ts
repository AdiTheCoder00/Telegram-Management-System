import type { Candle } from "@/lib/market/candles";
import type { Timeframe } from "@/lib/market/timeframes";
import type { Series } from "@/lib/indicators";
import { describeIndicator, getIndicator, resolveParams } from "@/lib/indicators/registry";
import { matchPattern, PATTERN_LABELS } from "@/lib/market/patterns";
import { inSession, resolveSession } from "@/lib/market/sessions";
import { COMPARATOR_LABELS, type ConditionNode, type Operand } from "@/lib/conditions/types";

/**
 * The single condition evaluator used by live alerts, the simulator/debugger and the backtester.
 *
 * EvaluationContext holds canonical candle series per timeframe and an evaluation instant `asOf`.
 * For each timeframe it selects the "current bar":
 *   - base timeframe, CANDLE_CLOSE mode → last candle with closeTime ≤ asOf (confirmed close only)
 *   - base timeframe, EVERY_TICK mode   → the candle containing asOf (may be FORMING)
 *   - any other timeframe               → last candle with closeTime ≤ asOf (a forming higher-timeframe
 *                                         candle is never treated as completed information)
 * Indicators are computed over the whole series once and read at the current index; because every
 * indicator is causal, this equals computing on the prefix — no look-ahead (verified by tests).
 */
export type EvaluationMode = "CANDLE_CLOSE" | "EVERY_TICK";

export interface ContextInput {
  symbol: string;
  baseTimeframe: Timeframe;
  mode: EvaluationMode;
  asOf: number;
  series: Partial<Record<Timeframe, Candle[]>>;
}

/** Last index with key(c) ≤ t (candles sorted by openTime ascending), or -1. */
function lastIndexAtOrBefore(c: Candle[], t: number, key: (c: Candle) => number) {
  let lo = 0;
  let hi = c.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(c[mid]) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export class EvaluationContext {
  readonly symbol: string;
  readonly baseTimeframe: Timeframe;
  readonly mode: EvaluationMode;
  private series: Partial<Record<Timeframe, Candle[]>>;
  private cache = new Map<string, Record<string, Series>>();
  private idx = new Map<Timeframe, number>();
  asOf = 0;

  constructor(input: ContextInput) {
    this.symbol = input.symbol;
    this.baseTimeframe = input.baseTimeframe;
    this.mode = input.mode;
    this.series = input.series;
    this.setAsOf(input.asOf);
  }

  /** Re-points the context at another instant (used by backtests); indicator caches stay valid. */
  setAsOf(asOf: number) {
    this.asOf = asOf;
    this.idx.clear();
    for (const [tf, candles] of Object.entries(this.series) as [Timeframe, Candle[]][]) {
      const valid = candles;
      const i =
        tf === this.baseTimeframe && this.mode === "EVERY_TICK"
          ? lastIndexAtOrBefore(valid, asOf, (c) => c.openTime)
          : lastIndexAtOrBefore(valid, asOf, (c) => c.closeTime);
      this.idx.set(tf, i);
    }
  }

  candles(tf: Timeframe): Candle[] {
    return this.series[tf] ?? [];
  }

  /** Index of the current bar for a timeframe (−1 if none yet). Offset 1 = previous bar. */
  index(tf: Timeframe, offset = 0): number {
    const i = this.idx.get(tf);
    if (i === undefined || i - offset < 0) return -1;
    return i - offset;
  }

  bar(tf: Timeframe, offset = 0): Candle | null {
    const i = this.index(tf, offset);
    return i < 0 ? null : (this.series[tf]?.[i] ?? null);
  }

  indicatorSeries(tf: Timeframe, key: string, params: Record<string, number>): Record<string, Series> | null {
    const def = getIndicator(key);
    if (!def) return null;
    const p = resolveParams(def, params);
    const cacheKey = `${tf}|${key}|${JSON.stringify(p)}`;
    let s = this.cache.get(cacheKey);
    if (!s) {
      // Series must stay index-aligned with candles(tf); invalid candles are removed earlier by normalizeCandles().
      s = def.compute(this.candles(tf), p);
      this.cache.set(cacheKey, s);
    }
    return s;
  }

  /** Value of an operand at the current bar (offset 0) or previous bar (offset 1); null = unavailable. */
  value(o: Operand, offset = 0): number | null {
    if (o.kind === "value") return o.value;
    const tf = o.timeframe ?? this.baseTimeframe;
    const i = this.index(tf, offset);
    if (i < 0) return null;
    let v: number | null;
    if (o.kind === "price") v = this.candles(tf)[i]?.[o.field] ?? null;
    else {
      const def = getIndicator(o.indicator);
      if (!def) return null;
      const s = this.indicatorSeries(tf, o.indicator, o.params);
      v = s?.[o.output ?? def.defaultOutput]?.[i] ?? null;
    }
    return v === null ? null : v * (o.multiplier ?? 1);
  }
}

// ─── evaluation results (the explainable trace that becomes trigger evidence) ─

export interface OperandTrace {
  label: string;
  current: number | null;
  previous?: number | null;
  timeframe?: Timeframe;
  candleTime?: string;
  candleState?: string;
}

export interface NodeResult {
  id: string;
  type: ConditionNode["type"];
  result: boolean | null; // null = could not evaluate (warm-up, missing data) → treated as not satisfied
  label: string;
  reason?: string;
  left?: OperandTrace;
  right?: OperandTrace;
  children?: NodeResult[];
}

export function describeOperand(o: Operand, base: Timeframe): string {
  if (o.kind === "value") return String(o.value);
  const tf = o.timeframe ?? base;
  const mult = o.multiplier && o.multiplier !== 1 ? ` × ${o.multiplier}` : "";
  if (o.kind === "price") return `${o.field === "close" ? "Price" : `Price ${o.field}`} [${tf}]${mult}`;
  return `${describeIndicator(o.indicator, o.params, o.output)} [${tf}]${mult}`;
}

const EPS = 1e-9;

function trace(ctx: EvaluationContext, o: Operand, withPrev: boolean): OperandTrace {
  const t: OperandTrace = { label: describeOperand(o, ctx.baseTimeframe), current: ctx.value(o, 0) };
  if (withPrev) t.previous = ctx.value(o, 1);
  if (o.kind !== "value") {
    const tf = o.timeframe ?? ctx.baseTimeframe;
    const bar = ctx.bar(tf);
    t.timeframe = tf;
    if (bar) {
      t.candleTime = new Date(bar.openTime).toISOString();
      t.candleState = bar.closeTime <= ctx.asOf ? "CLOSED" : "FORMING";
    }
  }
  return t;
}

function missingReason(ctx: EvaluationContext, o: Operand): string {
  if (o.kind === "indicator" && getIndicator(o.indicator)?.needsVolume) {
    const bar = ctx.bar(o.timeframe ?? ctx.baseTimeframe);
    if (bar && bar.volumeType === "UNAVAILABLE") return "Volume is not available from this data source.";
  }
  return "Not enough candles yet (indicator warm-up or missing history).";
}

export function evaluateNode(node: ConditionNode, ctx: EvaluationContext): NodeResult {
  switch (node.type) {
    case "group": {
      const children = node.children.map((c) => evaluateNode(c, ctx));
      let result: boolean | null;
      if (node.op === "AND")
        result = children.some((c) => c.result === false) ? false : children.some((c) => c.result === null) ? null : true;
      else result = children.some((c) => c.result === true) ? true : children.some((c) => c.result === null) ? null : false;
      return { id: node.id, type: "group", result, label: node.op === "AND" ? "All of" : "Any of", children };
    }
    case "not": {
      const child = evaluateNode(node.child, ctx);
      return { id: node.id, type: "not", result: child.result === null ? null : !child.result, label: "Not", children: [child] };
    }
    case "compare": {
      const crossing = node.op === "crosses_above" || node.op === "crosses_below";
      const left = trace(ctx, node.left, crossing);
      const right = trace(ctx, node.right, crossing);
      const label = `${left.label} ${COMPARATOR_LABELS[node.op]} ${right.label}`;
      const L = left.current;
      const R = right.current;
      if (L === null || R === null)
        return {
          id: node.id,
          type: "compare",
          result: null,
          label,
          left,
          right,
          reason: missingReason(ctx, L === null ? node.left : node.right),
        };
      let result: boolean;
      switch (node.op) {
        case ">":
          result = L > R + EPS;
          break;
        case ">=":
          result = L >= R - EPS;
          break;
        case "<":
          result = L < R - EPS;
          break;
        case "<=":
          result = L <= R + EPS;
          break;
        case "==":
          result = Math.abs(L - R) <= Math.max(node.tolerance ?? 0, EPS);
          break;
        default: {
          const pL = left.previous ?? null;
          const pR = right.previous ?? null;
          if (pL === null || pR === null)
            return {
              id: node.id,
              type: "compare",
              result: null,
              label,
              left,
              right,
              reason: "A crossing needs the previous bar's values too.",
            };
          result = node.op === "crosses_above" ? pL < pR - EPS && L >= R - EPS : pL > pR + EPS && L <= R + EPS;
        }
      }
      return { id: node.id, type: "compare", result, label, left, right };
    }
    case "pattern": {
      const tf = node.timeframe ?? ctx.baseTimeframe;
      const i = ctx.index(tf);
      const label = `${PATTERN_LABELS[node.pattern]} [${tf}]`;
      if (i < 0) return { id: node.id, type: "pattern", result: null, label, reason: "No candle yet." };
      const r = matchPattern(ctx.candles(tf), i, node.pattern, { bars: node.bars, dojiMaxBodyPct: node.dojiMaxBodyPct });
      const bar = ctx.candles(tf)[i];
      return {
        id: node.id,
        type: "pattern",
        result: r,
        label,
        reason: r === null ? "Not enough data for this pattern (previous bars or volume missing)." : undefined,
        left: {
          label: "Candle",
          current: bar.close,
          timeframe: tf,
          candleTime: new Date(bar.openTime).toISOString(),
          candleState: bar.closeTime <= ctx.asOf ? "CLOSED" : "FORMING",
        },
      };
    }
    case "session": {
      const def = resolveSession(node.session);
      // Sessions are checked at the evaluated base bar's open time (deterministic for live and backtest).
      const bar = ctx.bar(ctx.baseTimeframe);
      const t = bar ? bar.openTime : ctx.asOf;
      const result = inSession(t, def);
      return {
        id: node.id,
        type: "session",
        result,
        label: `In ${def.name} session (${def.start}–${def.end} ${def.timezone})`,
        reason: result ? undefined : `Bar at ${new Date(t).toISOString()} is outside the session.`,
      };
    }
  }
}

export interface Evaluation {
  result: boolean; // final decision (null from the tree → false)
  tree: NodeResult;
  asOf: string;
  baseCandle: { openTime: string; closeTime: string; state: string; close: number } | null;
  reason: string;
}

/** Evaluates the whole tree and summarises why it is (not) satisfied. */
export function evaluateConditions(root: ConditionNode, ctx: EvaluationContext): Evaluation {
  const tree = evaluateNode(root, ctx);
  const bar = ctx.bar(ctx.baseTimeframe);
  return {
    result: tree.result === true,
    tree,
    asOf: new Date(ctx.asOf).toISOString(),
    baseCandle: bar
      ? {
          openTime: new Date(bar.openTime).toISOString(),
          closeTime: new Date(bar.closeTime).toISOString(),
          state: bar.closeTime <= ctx.asOf ? "CLOSED" : "FORMING",
          close: bar.close,
        }
      : null,
    reason: summarize(tree),
  };
}

function summarize(tree: NodeResult): string {
  if (tree.result === true) return "All required conditions satisfied.";
  const failing: string[] = [];
  const pending: string[] = [];
  const walk = (n: NodeResult) => {
    if (n.children && n.type !== "not") n.children.forEach(walk);
    else if (n.result === false) failing.push(n.label);
    else if (n.result === null) pending.push(`${n.label} (${n.reason ?? "unavailable"})`);
  };
  walk(tree);
  if (failing.length) return `Not satisfied: ${failing.slice(0, 3).join("; ")}${failing.length > 3 ? "…" : ""}`;
  if (pending.length) return `Cannot evaluate yet: ${pending.slice(0, 2).join("; ")}`;
  return "Not satisfied.";
}
