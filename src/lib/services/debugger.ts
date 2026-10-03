import { z } from "zod";
import { db } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { conditionSchema, validateTree, type ConditionNode } from "@/lib/conditions/types";
import { evaluateConditions, type Evaluation as ConditionEvaluation } from "@/lib/conditions/evaluate";
import { buildWindowContext, lookbackBars } from "@/lib/conditions/window";
import { decide, type Reason } from "@/lib/engine/evaluate";
import { toState } from "@/lib/engine/engine";
import { getSeries } from "@/lib/market/service";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/timeframes";
import type { Candle } from "@/lib/market/candles";
import { isValidProvider } from "@/lib/market-data/registry";
import { symbolSchema } from "@/lib/validation";

/**
 * Condition simulator / debugger (M14). Runs the LIVE evaluation path — market-data service → fixed windows →
 * condition engine → trigger state machine — for an alert (or an unsaved configuration) at any instant, and
 * reports every step. Nothing is written: no state change, no evidence, no notification.
 *
 * At a past `asOf` it shows exactly what the live engine would have decided at that moment (no look-ahead:
 * only candles that existed then are used).
 */
export const debugInputSchema = z.object({
  alertId: z.string().max(40).optional(),
  config: z
    .object({
      symbol: symbolSchema,
      dataProvider: z.string().max(40),
      timeframe: z.enum(TIMEFRAMES),
      evaluationMode: z.enum(["CANDLE_CLOSE", "EVERY_TICK"]),
      conditionTree: z.unknown(),
    })
    .optional(),
  asOf: z.coerce.date().optional(),
});
export type DebugInput = z.infer<typeof debugInputSchema>;

const DECISION_TEXT: Record<Reason, string> = {
  triggered: "Would trigger and send a Telegram notification.",
  not_active: "Would not trigger: the alert is not active (paused, draft, triggered, expired or error).",
  expired: "Would not trigger: the alert has expired.",
  condition_not_met: "Would not trigger: the conditions are not satisfied.",
  disarmed: "Would not trigger: the alert already fired for this setup and is waiting for the conditions to become false (re-arm).",
  cooldown: "Would not trigger: the alert is in its cooldown window.",
  no_previous_price: "Would not trigger: not every condition could be evaluated yet (warm-up / missing data).",
};

const lastBars = (c: Candle[], n = 3) =>
  c.slice(-n).map((x) => ({ ...x, openTime: new Date(x.openTime).toISOString(), closeTime: new Date(x.closeTime).toISOString() }));

export async function debugConditions(userId: string, input: DebugInput) {
  let cfg: {
    symbol: string;
    dataProvider: string;
    timeframe: Timeframe;
    evaluationMode: "CANDLE_CLOSE" | "EVERY_TICK";
    conditionTree: unknown;
  };
  const alert = input.alertId
    ? await db.alert.findFirst({ where: { id: input.alertId, userId }, include: { bot: true, user: { select: { timezone: true } } } })
    : null;
  if (input.alertId && !alert) throw notFound("Alert");
  if (alert) {
    if (alert.kind !== "CONDITIONS") throw badRequest("The debugger works on indicator-condition alerts.");
    cfg = { ...alert, timeframe: alert.timeframe as Timeframe, conditionTree: input.config?.conditionTree ?? alert.conditionTree };
  } else if (input.config) cfg = input.config;
  else throw badRequest("Pass an alertId or a configuration.");

  if (!isValidProvider(cfg.dataProvider)) throw badRequest("Unknown market-data provider.");
  const parsed = conditionSchema.safeParse(cfg.conditionTree);
  if (!parsed.success) throw badRequest("The conditions are not a valid condition tree.");
  const tree: ConditionNode = parsed.data;
  const problems = validateTree(tree);
  if (problems.length) throw badRequest(problems[0], { issues: problems });

  const now = Date.now();
  const asOf = Math.min(input.asOf?.getTime() ?? now, now);
  const base = cfg.timeframe;
  const lookback = lookbackBars(tree, base);
  const scope = cfg.dataProvider === "webhook" ? userId : undefined;

  const series: Partial<Record<Timeframe, Candle[]>> = {};
  const data: Record<string, unknown>[] = [];
  let blocked: string | null = null;
  for (const [tf, bars] of lookback) {
    try {
      const r = await getSeries({ provider: cfg.dataProvider, symbol: cfg.symbol, timeframe: tf, asOf, bars: bars + 1, scope });
      series[tf] = r.candles;
      data.push({
        timeframe: tf,
        need: bars,
        have: r.candles.filter((c) => c.closeTime <= asOf || (tf === base && cfg.evaluationMode === "EVERY_TICK")).length,
        source: r.source,
        freshness: r.freshness.state,
        lagMs: r.freshness.lagMs,
        issues: r.issues.slice(0, 10),
        providerError: r.providerError ?? null,
        lastBars: lastBars(r.candles),
      });
      if (!blocked && (r.freshness.state === "STALE" || r.freshness.state === "NO_DATA" || r.freshness.state === "INVALID"))
        blocked = `${tf} data is ${r.freshness.state.toLowerCase().replace("_", " ")} — the live engine does not trigger on it.`;
    } catch (err) {
      data.push({ timeframe: tf, need: bars, error: (err as Error).message });
      blocked ??= `${tf} data could not be loaded: ${(err as Error).message}`;
    }
  }

  // The instant the live engine evaluates: the last closed base bar's close (CANDLE_CLOSE) or now (EVERY_TICK).
  const baseCandles = series[base] ?? [];
  const evalAt = cfg.evaluationMode === "CANDLE_CLOSE" ? (baseCandles.filter((c) => c.closeTime <= asOf).at(-1)?.closeTime ?? asOf) : asOf;
  const win = buildWindowContext({
    symbol: cfg.symbol,
    baseTimeframe: base,
    mode: cfg.evaluationMode,
    asOf: evalAt,
    tree,
    series,
    lookback,
  });

  let evaluation: ConditionEvaluation | null = null;
  let decision: { trigger: boolean; reason: Reason; text: string } | null = null;
  if (win.ctx) {
    evaluation = evaluateConditions(tree, win.ctx);
    if (alert) {
      const signal = { ready: evaluation.tree.result !== null, met: evaluation.result, reset: evaluation.tree.result === false };
      const d = decide(toState(alert), signal, new Date(evalAt), null);
      decision = {
        trigger: d.trigger && !blocked,
        reason: d.reason,
        text: blocked && d.trigger ? `Would not trigger: ${blocked}` : DECISION_TEXT[d.reason],
      };
    }
  }

  return {
    asOf: new Date(asOf).toISOString(),
    evaluatedAt: new Date(evalAt).toISOString(),
    config: { symbol: cfg.symbol, dataProvider: cfg.dataProvider, timeframe: base, evaluationMode: cfg.evaluationMode },
    data,
    blocked,
    insufficient: win.insufficient,
    windows: Object.fromEntries(
      Object.entries(win.windows).map(([tf, w]) => [
        tf,
        { from: new Date(w!.from).toISOString(), to: new Date(w!.to).toISOString(), bars: w!.bars },
      ]),
    ),
    evaluation,
    decision,
    alertState: alert
      ? {
          status: alert.status,
          armed: alert.armed,
          triggerCount: alert.triggerCount,
          lastTriggeredAt: alert.lastTriggeredAt,
          configVersion: alert.configVersion,
        }
      : null,
  };
}
export type DebugResult = Awaited<ReturnType<typeof debugConditions>>;
