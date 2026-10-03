import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import { conditionSchema, type ConditionNode } from "@/lib/conditions/types";
import { lookbackBars } from "@/lib/conditions/window";
import { TIMEFRAMES, timeframeMs, type Timeframe } from "@/lib/market/timeframes";
import type { Candle } from "@/lib/market/candles";
import { getProvider } from "@/lib/market-data/registry";
import { conditionProblems } from "@/lib/services/alerts";
import { symbolSchema } from "@/lib/validation";
import { datasetHash, engineVersions, runBacktest, warmupStart, type BacktestConfig, type BacktestResult } from "@/lib/backtest/engine";
import { loadHistory } from "@/lib/backtest/history";

/**
 * Backtest jobs (M15). Created by the API as QUEUED; executed by the worker (one at a time, claimed with
 * SELECT … FOR UPDATE SKIP LOCKED so two workers never run the same job). Every run stores what is needed to
 * reproduce it: the configuration snapshot (incl. alert version), engine versions, and the dataset identity
 * (provider, ranges, candle counts, SHA-256 of the exact candles).
 */
export const MAX_ACTIVE_PER_USER = 3;
export const MAX_BASE_BARS = 50_000;

export const backtestInputSchema = z
  .object({
    alertId: z.string().max(40).optional(),
    symbol: symbolSchema.optional(),
    dataProvider: z.string().max(40).optional(),
    timeframe: z.enum(TIMEFRAMES).optional(),
    evaluationMode: z.enum(["CANDLE_CLOSE", "EVERY_TICK"]).optional(),
    conditionTree: z.unknown().optional(),
    triggerMode: z.enum(["ONCE", "EVERY_TIME", "REARM"]).optional(),
    cooldownSeconds: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 86_400)
      .optional(),
    from: z.coerce.date(),
    to: z.coerce.date(),
    horizons: z.array(z.number().int().min(1).max(500)).min(1).max(6).default([1, 5, 10, 20]),
    direction: z.enum(["long", "short"]).default("long"),
  })
  .refine((v) => v.to > v.from, { message: "The end must be after the start.", path: ["to"] });
export type BacktestInput = z.infer<typeof backtestInputSchema>;

export async function createBacktest(userId: string, input: BacktestInput) {
  const active = await db.backtest.count({ where: { userId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active >= MAX_ACTIVE_PER_USER)
    throw new AppError(429, `At most ${MAX_ACTIVE_PER_USER} backtests can be queued or running at once.`, "limit");

  const alert = input.alertId ? await db.alert.findFirst({ where: { id: input.alertId, userId } }) : null;
  if (input.alertId && !alert) throw notFound("Alert");
  if (alert && alert.kind !== "CONDITIONS")
    throw badRequest("Backtests run indicator-condition alerts. Price-level alerts have nothing to replay on candles.");

  const pick = <T>(v: T | undefined, a: T | undefined, name: string): T => {
    const out = v ?? a;
    if (out === undefined || out === null) throw badRequest(`Missing ${name}.`);
    return out;
  };
  const timeframe = pick(input.timeframe, alert?.timeframe as Timeframe | undefined, "timeframe");
  const dataProvider = pick(input.dataProvider, alert?.dataProvider, "data provider");
  const tree = conditionSchema.safeParse(input.conditionTree ?? alert?.conditionTree);
  if (!tree.success) throw badRequest("The conditions are not a valid condition tree.");
  const problems = conditionProblems(tree.data, dataProvider, timeframe);
  if (problems.length) throw badRequest(problems[0], { issues: problems });

  const p = getProvider(dataProvider)!;
  const now = Date.now();
  const to = Math.min(input.to.getTime(), now);
  const from = input.from.getTime();
  if (to <= from) throw badRequest("The range ends in the future or before it starts.");
  const bars = Math.ceil((to - from) / timeframeMs(timeframe));
  if (bars > MAX_BASE_BARS)
    throw badRequest(`Range too large: about ${bars} ${timeframe} bars (max ${MAX_BASE_BARS}). Shorten it or use a higher timeframe.`);
  if (p.capabilities.historyDays > 0 && from < now - p.capabilities.historyDays * 86_400_000)
    throw badRequest(`${p.label} provides about ${p.capabilities.historyDays} days of history.`);

  const config: BacktestConfig = {
    symbol: pick(input.symbol, alert?.symbol, "symbol"),
    dataProvider,
    timeframe,
    evaluationMode: input.evaluationMode ?? alert?.evaluationMode ?? "CANDLE_CLOSE",
    conditionTree: tree.data,
    triggerMode: input.triggerMode ?? alert?.triggerMode ?? "REARM",
    cooldownSeconds: input.cooldownSeconds ?? alert?.cooldownSeconds ?? 0,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    horizons: [...new Set(input.horizons)].sort((a, b) => a - b),
    direction: input.direction,
  };
  const bt = await db.backtest.create({
    data: {
      userId,
      alertId: alert?.id ?? null,
      alertVersion: alert?.configVersion ?? null,
      config: config as unknown as Prisma.InputJsonValue,
      engineVersions: engineVersions(),
    },
  });
  logger.info("Backtest queued", { userId, backtestId: bt.id, symbol: config.symbol, timeframe });
  return serializeBacktest(bt);
}

type Row = Awaited<ReturnType<typeof db.backtest.findFirstOrThrow>>;
export function serializeBacktest(b: Row, full = false) {
  const result = b.result as unknown as BacktestResult | null;
  return {
    id: b.id,
    alertId: b.alertId,
    alertVersion: b.alertVersion,
    status: b.status,
    progress: b.progress,
    config: b.config as unknown as BacktestConfig,
    dataset: b.dataset,
    engineVersions: b.engineVersions,
    error: b.error,
    createdAt: b.createdAt,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    summary: result?.summary ?? null,
    ...(full ? { triggers: result?.triggers ?? [] } : {}),
  };
}

export async function listBacktests(userId: string) {
  const rows = await db.backtest.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((r) => serializeBacktest(r));
}

export async function getBacktest(userId: string, id: string) {
  const b = await db.backtest.findFirst({ where: { id, userId } });
  if (!b) throw notFound("Backtest");
  return serializeBacktest(b, true);
}

export async function cancelBacktest(userId: string, id: string) {
  const b = await db.backtest.findFirst({ where: { id, userId } });
  if (!b) throw notFound("Backtest");
  if (b.status === "QUEUED")
    await db.backtest.updateMany({ where: { id, status: "QUEUED" }, data: { status: "CANCELLED", finishedAt: new Date() } });
  else if (b.status === "RUNNING") await db.backtest.update({ where: { id }, data: { cancelRequested: true } });
  return getBacktest(userId, id);
}

export async function deleteBacktest(userId: string, id: string) {
  const b = await db.backtest.findFirst({ where: { id, userId } });
  if (!b) throw notFound("Backtest");
  if (b.status === "RUNNING") throw badRequest("Cancel the backtest before deleting it.");
  await db.backtest.delete({ where: { id } });
}

// ─── execution (worker) ──────────────────────────────────────────────────────

/** Loads all timeframes the tree needs, with warm-up history before `from`. */
async function loadSeries(userId: string, cfg: BacktestConfig, cancelled: () => Promise<boolean>) {
  const from = Date.parse(cfg.from);
  const to = Date.parse(cfg.to);
  const starts = warmupStart(cfg.conditionTree, cfg.timeframe, from);
  const series: Partial<Record<Timeframe, Candle[]>> = {};
  const dataset: Record<string, unknown> = { provider: cfg.dataProvider, symbol: cfg.symbol, timeframes: {} as Record<string, unknown> };
  for (const tf of lookbackBars(cfg.conditionTree, cfg.timeframe).keys()) {
    // The base timeframe also loads candles after `to` (up to the longest horizon) for forward statistics only.
    const end = tf === cfg.timeframe ? Math.min(Date.now(), to + (Math.max(...cfg.horizons) + 1) * timeframeMs(tf)) : to;
    const h = await loadHistory({
      provider: cfg.dataProvider,
      symbol: cfg.symbol,
      timeframe: tf,
      from: starts.get(tf)!,
      to: end,
      scope: userId,
      cancelled,
    });
    series[tf] = h.candles;
    (dataset.timeframes as Record<string, unknown>)[tf] = {
      source: h.source,
      candles: h.candles.length,
      first: h.candles[0] ? new Date(h.candles[0].openTime).toISOString() : null,
      last: h.candles.length ? new Date(h.candles.at(-1)!.openTime).toISOString() : null,
      issues: h.issues.length,
      issueSample: h.issues.slice(0, 5),
      requests: h.requests,
    };
  }
  dataset.sha256 = datasetHash(series);
  dataset.synthetic = !!getProvider(cfg.dataProvider)?.capabilities.synthetic;
  return { series, dataset };
}

export async function executeBacktest(id: string) {
  const bt = await db.backtest.findUniqueOrThrow({ where: { id } });
  const cfg = bt.config as unknown as BacktestConfig;
  cfg.conditionTree = conditionSchema.parse(cfg.conditionTree) as ConditionNode;
  const cancelled = async () => !!(await db.backtest.findUnique({ where: { id }, select: { cancelRequested: true } }))?.cancelRequested;
  let lastWrite = 0;
  try {
    const { series, dataset } = await loadSeries(bt.userId, cfg, cancelled);
    await db.backtest.update({ where: { id }, data: { dataset: dataset as Prisma.InputJsonValue, progress: 0.05 } });
    const result = await runBacktest(cfg, series, {
      cancelled,
      onProgress: async (p) => {
        if (Date.now() - lastWrite < 1000 && p < 1) return;
        lastWrite = Date.now();
        await db.backtest.update({ where: { id }, data: { progress: 0.05 + 0.95 * p } });
      },
    });
    await db.backtest.update({
      where: { id },
      data: {
        status: "COMPLETED",
        result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        progress: 1,
        finishedAt: new Date(),
      },
    });
    logger.info("Backtest completed", { backtestId: id, triggers: result.summary.triggers });
  } catch (err) {
    const msg = (err as Error).message;
    const wasCancel = msg === "cancelled";
    await db.backtest.update({
      where: { id },
      data: { status: wasCancel ? "CANCELLED" : "FAILED", error: wasCancel ? null : msg.slice(0, 1000), finishedAt: new Date() },
    });
    if (!wasCancel) logger.warn("Backtest failed", { backtestId: id, err: msg });
  }
}

/** Claims and runs the oldest queued backtest. Returns false when there was nothing to do. */
export async function runNextBacktest(): Promise<boolean> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Backtest" SET "status" = 'RUNNING', "startedAt" = now(), "progress" = 0
    WHERE "id" = (SELECT "id" FROM "Backtest" WHERE "status" = 'QUEUED' ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  if (!claimed.length) return false;
  await executeBacktest(claimed[0].id);
  return true;
}

/** On worker start: runs interrupted by a crash/restart are marked FAILED (they can simply be re-run). */
export async function failInterruptedBacktests() {
  const r = await db.backtest.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "FAILED",
      error: "Interrupted: the worker stopped while this backtest was running. Run it again.",
      finishedAt: new Date(),
    },
  });
  return r.count;
}
