import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Alert, TelegramBot } from "@/generated/prisma/client";
import { conditionSchema, type ConditionNode } from "@/lib/conditions/types";
import { evaluateConditions, type Evaluation as ConditionEvaluation, type NodeResult } from "@/lib/conditions/evaluate";
import { buildWindowContext, lookbackBars } from "@/lib/conditions/window";
import { decide, type Signal } from "@/lib/engine/evaluate";
import { commitEvaluation, toState, type Triggered } from "@/lib/engine/engine";
import { getSeries, type SeriesRequest, type SeriesResult } from "@/lib/market/service";
import { isTimeframe, type Timeframe } from "@/lib/market/timeframes";
import type { Candle } from "@/lib/market/candles";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Live evaluation of condition-tree alerts (kind = CONDITIONS).
 *
 *   market-data service (validated candles + freshness) → fixed windows → condition engine → decide()
 *   → commitEvaluation() (evidence + idempotency) → notification outbox
 *
 * CANDLE_CLOSE: every closed base candle is evaluated exactly once, in order, at its own close time — the same
 * instants a backtest uses. If the worker fell behind, up to MAX_CATCHUP_BARS missed bars are evaluated; older
 * ones are skipped (recorded in the alert's note) rather than producing a burst of stale notifications.
 * EVERY_TICK: the forming base candle is evaluated each cycle; at most one trigger per base candle per alert
 * version (idempotency key).
 * Stale, invalid or missing data never triggers: the alert's marketDataState explains why it is waiting.
 */
export const MAX_CATCHUP_BARS = 3;

type AlertWithBot = Alert & { bot: TelegramBot | null; user: { timezone: string } };
type FetchSeries = (req: SeriesRequest) => Promise<SeriesResult>;

export interface ConditionEngineResult {
  evaluated: number;
  triggered: Triggered[];
  waiting: Record<string, number>;
}

export function parseTree(json: unknown): ConditionNode | null {
  const r = conditionSchema.safeParse(json);
  return r.success ? r.data : null;
}

/** "RSI(14) [5m] = 61.30 (prev 58.70); EMA(50) [1h] = 3912.80" — for {{indicator_values}} and evidence. */
export function summarizeValues(tree: NodeResult, max = 8): string {
  const out: string[] = [];
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? "n/a" : Number(v.toFixed(Math.abs(v) < 10 ? 5 : 2)).toString();
  const walk = (n: NodeResult) => {
    if (n.children) n.children.forEach(walk);
    for (const t of [n.left, n.right]) {
      if (!t || !t.timeframe) continue; // constants
      const s = `${t.label} = ${fmt(t.current)}${t.previous !== undefined ? ` (prev ${fmt(t.previous)})` : ""}`;
      if (!out.includes(s)) out.push(s);
    }
  };
  walk(tree);
  return out.slice(0, max).join("; ") || "—";
}

async function markWaiting(alert: Alert, state: string, note: string) {
  if (alert.marketDataState === state && alert.lastEvaluationNote === note) return;
  await db.alert.updateMany({
    where: { id: alert.id, version: alert.version },
    data: { marketDataState: state, lastEvaluationNote: note, version: { increment: 1 } },
  });
}

/** Evaluates one condition alert against freshly fetched series. Exported for the simulator and tests. */
export async function evaluateConditionAlert(
  alert: AlertWithBot,
  now: Date,
  fetchSeries: FetchSeries = getSeries,
): Promise<{ triggered: Triggered[]; waiting?: string }> {
  const tree = parseTree(alert.conditionTree);
  if (!tree || !isTimeframe(alert.timeframe)) {
    await markWaiting(alert, "ERROR", "The alert's conditions are invalid. Edit and save the alert.");
    return { triggered: [], waiting: "ERROR" };
  }
  const base = alert.timeframe as Timeframe;
  const lookback = lookbackBars(tree, base);
  const scope = alert.dataProvider === "webhook" ? alert.userId : undefined;

  const series: Partial<Record<Timeframe, Candle[]>> = {};
  const meta: Record<string, unknown> = {};
  for (const [tf, bars] of lookback) {
    let res: SeriesResult;
    try {
      res = await fetchSeries({
        provider: alert.dataProvider,
        symbol: alert.symbol,
        timeframe: tf,
        asOf: now.getTime(),
        bars: bars + MAX_CATCHUP_BARS + 1,
        scope,
      });
    } catch (err) {
      await markWaiting(alert, "STALE", `Market data unavailable: ${(err as Error).message}`);
      return { triggered: [], waiting: "STALE" };
    }
    if (res.freshness.state === "STALE" || res.freshness.state === "NO_DATA" || res.freshness.state === "INVALID") {
      const why =
        res.freshness.state === "INVALID"
          ? "invalid (future-dated) timestamps from the provider"
          : res.freshness.state === "NO_DATA"
            ? "no candles yet"
            : "stale data";
      await markWaiting(
        alert,
        res.freshness.state === "NO_DATA" ? "STALE" : res.freshness.state,
        `Waiting for ${tf} ${alert.symbol}: ${why}. No triggers until fresh data arrives.`,
      );
      return { triggered: [], waiting: res.freshness.state };
    }
    series[tf] = res.candles;
    meta[tf] = { source: res.source, freshness: res.freshness.state, issues: res.issues.length, providerError: res.providerError ?? null };
  }

  const baseCandles = series[base] ?? [];
  // Instants to evaluate
  const instants: { asOf: number; bar: Candle }[] = [];
  let skippedNote: string | null = null;
  if (alert.evaluationMode === "CANDLE_CLOSE") {
    const closed = baseCandles.filter((c) => c.closeTime <= now.getTime());
    const last = alert.lastEvaluatedCandle?.getTime() ?? null;
    let pending = last === null ? closed.slice(-1) : closed.filter((c) => c.openTime > last);
    if (pending.length > MAX_CATCHUP_BARS) {
      skippedNote = `${pending.length - MAX_CATCHUP_BARS} older ${base} candle(s) were not evaluated after a delay (only the last ${MAX_CATCHUP_BARS} are caught up).`;
      pending = pending.slice(-MAX_CATCHUP_BARS);
    }
    for (const bar of pending) instants.push({ asOf: bar.closeTime, bar });
  } else {
    const forming = baseCandles.filter((c) => c.openTime <= now.getTime()).at(-1);
    if (forming) instants.push({ asOf: now.getTime(), bar: forming });
  }
  if (!instants.length) return { triggered: [] };

  const triggered: Triggered[] = [];
  let current: AlertWithBot = alert;
  for (const { asOf, bar } of instants) {
    const win = buildWindowContext({ symbol: alert.symbol, baseTimeframe: base, mode: alert.evaluationMode, asOf, tree, series, lookback });
    const at = new Date(asOf);
    if (!win.ctx) {
      const need = win.insufficient.map((i) => `${i.timeframe}: ${i.have}/${i.need} bars`).join(", ");
      await commitEvaluation(
        current,
        decide(toState(current), { ready: false, met: false, reset: false }, at, current.lastPrice),
        now,
        {
          lastEvaluatedCandle: alert.evaluationMode === "CANDLE_CLOSE" ? new Date(bar.openTime) : undefined,
          marketDataState: "INSUFFICIENT_HISTORY",
          lastEvaluationNote: `Not enough history yet (${need}).`,
        },
        null,
      );
      current = await reload(current);
      continue;
    }
    const evaluation: ConditionEvaluation = evaluateConditions(tree, win.ctx);
    const signal: Signal = { ready: evaluation.tree.result !== null, met: evaluation.result, reset: evaluation.tree.result === false };
    const dec = decide(toState(current), signal, at, bar.close);
    const evidenceJson = JSON.parse(
      JSON.stringify({ ...evaluation, windows: win.windows, lookback: Object.fromEntries(lookback) }),
    ) as Prisma.InputJsonValue;
    const out = await commitEvaluation(
      current,
      dec,
      now,
      {
        lastEvaluatedCandle: alert.evaluationMode === "CANDLE_CLOSE" ? new Date(bar.openTime) : undefined,
        marketDataState: "FRESH",
        lastEvaluationNote: skippedNote ?? (evaluation.tree.result === null ? evaluation.reason : null),
      },
      dec.trigger
        ? {
            evidence: {
              idempotencyKey: `${alert.id}:v${alert.configVersion}:${alert.symbol}:${base}:${bar.openTime}:${alert.evaluationMode}`,
              provider: alert.dataProvider,
              timeframe: base,
              candleOpenTime: new Date(bar.openTime),
              candleState: bar.closeTime <= asOf ? "CLOSED" : "FORMING",
              price: bar.close,
              marketDataTime: new Date(Math.min(bar.closeTime, asOf)),
              providerMeta: JSON.parse(JSON.stringify(meta)) as Prisma.InputJsonValue,
              evaluation: evidenceJson,
              reason: evaluation.reason,
            },
            message: { triggerReason: evaluation.reason, indicatorValues: summarizeValues(evaluation.tree) },
          }
        : null,
    );
    if (out) {
      triggered.push(out);
      logger.info("Condition alert triggered", {
        alertId: alert.id,
        symbol: alert.symbol,
        timeframe: base,
        candle: new Date(bar.openTime).toISOString(),
      });
    }
    current = await reload(current);
    skippedNote = null;
  }
  return { triggered };
}

async function reload(a: AlertWithBot): Promise<AlertWithBot> {
  return (await db.alert.findUnique({ where: { id: a.id }, include: { bot: true, user: { select: { timezone: true } } } })) ?? a;
}

/** One engine cycle over every live condition alert (worker / cron). Series are shared within a cycle. */
export async function evaluateConditionAlerts(now = new Date(), fetchSeries: FetchSeries = getSeries): Promise<ConditionEngineResult> {
  const alerts = await db.alert.findMany({
    where: { kind: "CONDITIONS", status: { in: ["ACTIVE", "COOLDOWN"] } },
    include: { bot: true, user: { select: { timezone: true } } },
  });
  const cache = new Map<string, Promise<SeriesResult>>();
  const cached: FetchSeries = (req) => {
    const key = `${req.provider}|${req.scope ?? ""}|${req.symbol}|${req.timeframe}|${req.bars}`;
    let p = cache.get(key);
    if (!p) {
      p = fetchSeries(req);
      cache.set(key, p);
    }
    return p;
  };
  const result: ConditionEngineResult = { evaluated: alerts.length, triggered: [], waiting: {} };
  for (const alert of alerts) {
    try {
      const r = await evaluateConditionAlert(alert, now, cached);
      result.triggered.push(...r.triggered);
      if (r.waiting) result.waiting[r.waiting] = (result.waiting[r.waiting] ?? 0) + 1;
    } catch (err) {
      logger.error("Condition alert evaluation failed", { alertId: alert.id, err });
    }
  }
  return result;
}
