import { createHash } from "node:crypto";
import type { Candle } from "@/lib/market/candles";
import { timeframeMs, type Timeframe } from "@/lib/market/timeframes";
import { EVALUATION_ENGINE_VERSION, type ConditionNode } from "@/lib/conditions/types";
import { evaluateConditions, type NodeResult } from "@/lib/conditions/evaluate";
import { buildWindowContext, lookbackBars } from "@/lib/conditions/window";
import { INDICATOR_ENGINE_VERSION } from "@/lib/indicators";
import { decide, type TriggerState } from "@/lib/engine/evaluate";
import { summarizeValues } from "@/lib/engine/condition-engine";

/**
 * Backtest engine (M15) — a pure function of (configuration, candles).
 *
 * It replays every CLOSED base candle in [from, to) in time order and, at each candle's close, runs EXACTLY the
 * live pipeline: fixed L-bar windows (buildWindowContext) → evaluateConditions → decide() (the shared trigger
 * state machine with once/re-arm/every-time and cooldown). Candles after the instant are never visible
 * (buildWindowContext slices by asOf), so there is no look-ahead. Forward statistics (returns, MFE/MAE) are
 * computed AFTER the decision, from later candles, and never influence it.
 *
 * EVERY_TICK alerts cannot be reproduced from candles (the intrabar path is unknown); they are replayed at candle
 * close and the result is flagged `intrabarApproximated`.
 */
export const BACKTEST_ENGINE_VERSION = "1.0.0";

export const engineVersions = () => ({
  backtest: BACKTEST_ENGINE_VERSION,
  evaluation: EVALUATION_ENGINE_VERSION,
  indicators: INDICATOR_ENGINE_VERSION,
});

export interface BacktestConfig {
  symbol: string;
  dataProvider: string;
  timeframe: Timeframe;
  evaluationMode: "CANDLE_CLOSE" | "EVERY_TICK";
  conditionTree: ConditionNode;
  triggerMode: "ONCE" | "EVERY_TIME" | "REARM";
  cooldownSeconds: number;
  from: string; // ISO, inclusive (first candle open)
  to: string; // ISO, exclusive (last candle must close by then)
  /** Forward horizons in base bars for return statistics. */
  horizons: number[];
  /** Direction used for MFE/MAE ("long": up is favourable). */
  direction: "long" | "short";
}

export interface BacktestTrigger {
  n: number;
  candleOpenTime: string;
  time: string; // decision instant = candle close
  price: number;
  reason: string;
  values: string;
  forward: Record<string, number | null>; // horizon → % return (direction-adjusted), null = not enough future data
  mfePct: number | null;
  maePct: number | null;
  tree?: NodeResult;
}

export interface BacktestResult {
  triggers: BacktestTrigger[];
  summary: {
    barsEvaluated: number;
    barsInsufficient: number;
    triggers: number;
    suppressed: { cooldown: number; disarmed: number };
    conditionTrueBars: number;
    horizons: Record<string, { n: number; avgPct: number | null; medianPct: number | null; winRate: number | null }>;
    avgMfePct: number | null;
    avgMaePct: number | null;
    firstBar: string | null;
    lastBar: string | null;
    intrabarApproximated: boolean;
  };
}

const pct = (a: number, b: number) => ((b - a) / a) * 100;
const round = (x: number) => Math.round(x * 10_000) / 10_000;
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** SHA-256 over the exact candles used (per timeframe, in order) — identical data ⇒ identical hash. */
export function datasetHash(series: Partial<Record<Timeframe, Candle[]>>): string {
  const h = createHash("sha256");
  for (const tf of Object.keys(series).sort()) {
    h.update(`#${tf}\n`);
    for (const c of series[tf as Timeframe]!) h.update(`${c.openTime},${c.open},${c.high},${c.low},${c.close},${c.volume ?? ""}\n`);
  }
  return h.digest("hex");
}

export async function runBacktest(
  cfg: BacktestConfig,
  series: Partial<Record<Timeframe, Candle[]>>,
  opts: { onProgress?: (p: number) => Promise<void> | void; cancelled?: () => Promise<boolean>; keepTrees?: number } = {},
): Promise<BacktestResult> {
  const base = cfg.timeframe;
  const from = Date.parse(cfg.from);
  const to = Date.parse(cfg.to);
  const lookback = lookbackBars(cfg.conditionTree, base);
  const candles = series[base] ?? [];
  const bars = candles.filter((c) => c.openTime >= from && c.closeTime <= to);
  const maxH = Math.max(0, ...cfg.horizons);
  const indexOf = new Map(candles.map((c, i) => [c.openTime, i]));
  const sign = cfg.direction === "short" ? -1 : 1;

  let state: TriggerState = {
    triggerMode: cfg.triggerMode,
    cooldownSeconds: cfg.cooldownSeconds,
    expiryType: "NEVER",
    expiresAt: null,
    maxTriggers: null,
    triggerCount: 0,
    lastTriggeredAt: null,
    armed: true,
    lastPrice: null,
    status: "ACTIVE",
  };

  const triggers: BacktestTrigger[] = [];
  const summary: BacktestResult["summary"] = {
    barsEvaluated: 0,
    barsInsufficient: 0,
    triggers: 0,
    suppressed: { cooldown: 0, disarmed: 0 },
    conditionTrueBars: 0,
    horizons: {},
    avgMfePct: null,
    avgMaePct: null,
    firstBar: bars[0] ? new Date(bars[0].openTime).toISOString() : null,
    lastBar: bars.length ? new Date(bars.at(-1)!.openTime).toISOString() : null,
    intrabarApproximated: cfg.evaluationMode === "EVERY_TICK",
  };

  for (let k = 0; k < bars.length; k++) {
    const bar = bars[k];
    if (k % 250 === 0) {
      if (opts.cancelled && (await opts.cancelled())) throw new Error("cancelled");
      await opts.onProgress?.(k / bars.length);
    }
    const asOf = bar.closeTime;
    const win = buildWindowContext({
      symbol: cfg.symbol,
      baseTimeframe: base,
      mode: "CANDLE_CLOSE",
      asOf,
      tree: cfg.conditionTree,
      series,
      lookback,
    });
    if (!win.ctx) {
      summary.barsInsufficient++;
      continue;
    }
    summary.barsEvaluated++;
    const ev = evaluateConditions(cfg.conditionTree, win.ctx);
    if (ev.result) summary.conditionTrueBars++;
    const d = decide(state, { ready: ev.tree.result !== null, met: ev.result, reset: ev.tree.result === false }, new Date(asOf), bar.close);
    if (d.reason === "cooldown") summary.suppressed.cooldown++;
    if (d.reason === "disarmed") summary.suppressed.disarmed++;
    state = { ...state, ...d.next };
    if (!d.trigger) {
      if (state.status === "TRIGGERED" || state.status === "EXPIRED") break; // ONCE: nothing more can happen
      continue;
    }

    // Forward statistics — measured strictly after the decision.
    const i = indexOf.get(bar.openTime)!;
    const forward: Record<string, number | null> = {};
    for (const h of cfg.horizons) {
      const f = candles[i + h];
      forward[h] = f && f.closeTime <= Date.now() ? round(sign * pct(bar.close, f.close)) : null;
    }
    let mfe: number | null = null;
    let mae: number | null = null;
    const window = candles.slice(i + 1, i + 1 + maxH);
    if (window.length) {
      const up = Math.max(...window.map((c) => pct(bar.close, c.high)));
      const down = Math.min(...window.map((c) => pct(bar.close, c.low)));
      mfe = round(sign > 0 ? up : -down);
      mae = round(sign > 0 ? down : -up);
    }
    triggers.push({
      n: triggers.length + 1,
      candleOpenTime: new Date(bar.openTime).toISOString(),
      time: new Date(asOf).toISOString(),
      price: bar.close,
      reason: ev.reason,
      values: summarizeValues(ev.tree),
      forward,
      mfePct: mfe,
      maePct: mae,
      ...(triggers.length < (opts.keepTrees ?? 200) ? { tree: ev.tree } : {}),
    });
  }

  summary.triggers = triggers.length;
  for (const h of cfg.horizons) {
    const xs = triggers.map((t) => t.forward[h]).filter((x): x is number => x !== null);
    summary.horizons[h] = {
      n: xs.length,
      avgPct: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
      medianPct: xs.length ? round(median(xs)!) : null,
      winRate: xs.length ? round((xs.filter((x) => x > 0).length / xs.length) * 100) : null,
    };
  }
  const mfes = triggers.map((t) => t.mfePct).filter((x): x is number => x !== null);
  const maes = triggers.map((t) => t.maePct).filter((x): x is number => x !== null);
  summary.avgMfePct = mfes.length ? round(mfes.reduce((a, b) => a + b, 0) / mfes.length) : null;
  summary.avgMaePct = maes.length ? round(maes.reduce((a, b) => a + b, 0) / maes.length) : null;
  await opts.onProgress?.(1);
  return { triggers, summary };
}

/**
 * Warm-up start per timeframe: enough history before `from` to fill every fixed window. Generous on purpose —
 * markets have weekend/holiday gaps, so twice the bars plus four days for intraday timeframes.
 */
export function warmupStart(tree: ConditionNode, base: Timeframe, from: number): Map<Timeframe, number> {
  const out = new Map<Timeframe, number>();
  for (const [tf, bars] of lookbackBars(tree, base)) {
    const ms = tf === "1M" ? 31 * 86_400_000 : timeframeMs(tf);
    out.set(tf, from - (bars * 2 + 2) * ms - (ms < 86_400_000 ? 4 * 86_400_000 : 0));
  }
  return out;
}
