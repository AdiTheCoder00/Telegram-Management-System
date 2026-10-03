import { db } from "@/lib/db";
import { getProvider } from "@/lib/market-data/registry";
import { MarketDataError, type MarketDataProvider } from "@/lib/market-data/types";
import { aggregate, normalizeCandles, type Candle, type DataIssue, type VolumeType } from "@/lib/market/candles";
import { canAggregate, compareTimeframes, timeframeMs, type Timeframe } from "@/lib/market/timeframes";
import { GLOBAL, recordProviderFailure, recordProviderSuccess } from "@/lib/market/service";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Historical candle loader for backtests (M15). Same sources and the same normalisation as the live market-data
 * service — only the range differs:
 *
 *   native timeframe   → provider pages (backwards, ≤5000 bars per request) + DB cache (non-synthetic providers)
 *   other timeframes   → loaded from the highest native lower timeframe, then aggregate()
 *   push/tick feeds    → pushed bars or 1m tick candles from the database
 *
 * Nothing is repaired: gaps, duplicates and bad OHLC are reported as issues in the dataset.
 */
export const MAX_BARS_PER_TIMEFRAME = 100_000;
const PAGE = 5000;

export interface HistoryResult {
  candles: Candle[];
  issues: DataIssue[];
  source: "provider" | "cache" | "aggregated" | "pushed" | "ticks" | "synthetic";
  requests: number;
}

type Row = { openTime: Date; open: number; high: number; low: number; close: number; volume: number | null; volumeType: string };
const toCandle = (r: Row, tf: Timeframe): Candle => ({
  openTime: r.openTime.getTime(),
  closeTime: r.openTime.getTime() + timeframeMs(tf),
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  volumeType: r.volumeType as VolumeType,
  state: "CLOSED",
});

async function waitForBudget(p: MarketDataProvider, signal?: () => Promise<boolean>) {
  if (p.capabilities.synthetic) return;
  const perMin = Number(p.key === "twelvedata" ? (process.env.TWELVE_DATA_RATE_LIMIT_PER_MIN ?? 8) : 60);
  for (let i = 0; i < 120; i++) {
    if ((await rateLimit(`provider:${p.key}`, perMin, 60_000)).ok) return;
    if (signal && (await signal())) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new MarketDataError(p.key, "Provider request budget exhausted for too long");
}

async function loadNative(
  p: MarketDataProvider,
  symbol: string,
  tf: Timeframe,
  from: number,
  to: number,
  cancelled?: () => Promise<boolean>,
) {
  const inst = await db.instrument.findUnique({ where: { symbol }, select: { providerSymbol: true } });
  const ref = { symbol, providerSymbol: inst?.providerSymbol ?? null };
  const span = Math.ceil((to - from) / timeframeMs(tf));
  if (span > MAX_BARS_PER_TIMEFRAME) throw new Error(`Range too large: ${span} ${tf} bars (max ${MAX_BARS_PER_TIMEFRAME}).`);

  // Cached history first (non-synthetic): if it covers the range end to end, no provider request is needed.
  if (!p.capabilities.synthetic) {
    const rows = await db.candle.findMany({
      where: { provider: p.key, scope: GLOBAL, symbol, timeframe: tf, closed: true, openTime: { gte: new Date(from), lt: new Date(to) } },
      orderBy: { openTime: "asc" },
    });
    const covered =
      rows.length > 0 &&
      rows[0].openTime.getTime() <= from + timeframeMs(tf) * 3 &&
      rows.at(-1)!.openTime.getTime() >= to - timeframeMs(tf) * 3;
    if (covered) return { candles: rows.map((r) => toCandle(r, tf)), source: "cache" as const, requests: 0 };
  }

  const out = new Map<number, Candle>();
  let cursor = to;
  let requests = 0;
  while (cursor > from) {
    if (cancelled && (await cancelled())) throw new Error("cancelled");
    await waitForBudget(p, cancelled);
    let page: Candle[];
    try {
      page = await p.getCandles!(ref, tf, { from, to: cursor, limit: PAGE });
      requests++;
      await recordProviderSuccess(p.key);
    } catch (err) {
      await recordProviderFailure(p.key, (err as Error).message);
      throw err;
    }
    if (!page.length) break;
    for (const c of page) if (c.openTime >= from && c.openTime < to) out.set(c.openTime, c);
    const earliest = Math.min(...page.map((c) => c.openTime));
    if (earliest >= cursor) break; // provider ignored the cursor; avoid looping
    cursor = earliest;
    if (page.length < PAGE / 2 && !p.capabilities.synthetic) break; // provider has nothing older
  }
  const candles = [...out.values()].sort((a, b) => a.openTime - b.openTime);

  if (!p.capabilities.synthetic && candles.length) {
    const now = Date.now();
    for (let i = 0; i < candles.length; i += 1000) {
      await db.candle.createMany({
        data: candles.slice(i, i + 1000).map((c) => ({
          provider: p.key,
          scope: GLOBAL,
          symbol,
          timeframe: tf,
          openTime: new Date(c.openTime),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          volumeType: c.volumeType,
          closed: c.closeTime <= now,
        })),
        skipDuplicates: true,
      });
    }
  }
  return { candles, source: p.capabilities.synthetic ? ("synthetic" as const) : ("provider" as const), requests };
}

async function loadStored(provider: string, scope: string | undefined, symbol: string, tf: Timeframe, from: number, to: number) {
  if (scope && scope !== GLOBAL) {
    const pushed = await db.candle.findMany({
      where: { provider, scope, symbol, timeframe: tf, volumeType: { not: "TICK" }, openTime: { gte: new Date(from), lt: new Date(to) } },
      orderBy: { openTime: "asc" },
      take: MAX_BARS_PER_TIMEFRAME,
    });
    if (pushed.length) return { candles: pushed.map((r) => toCandle(r, tf)), source: "pushed" as const, requests: 0 };
  }
  const load = (s: string) =>
    db.candle.findMany({
      where: { provider, scope: s, symbol, timeframe: "1m", volumeType: "TICK", openTime: { gte: new Date(from), lt: new Date(to) } },
      orderBy: { openTime: "asc" },
      take: MAX_BARS_PER_TIMEFRAME * 5,
    });
  let rows = scope && scope !== GLOBAL ? await load(scope) : [];
  if (!rows.length) rows = await load(GLOBAL);
  const m1 = rows.map((r) => toCandle(r, "1m"));
  return { candles: tf === "1m" ? m1 : aggregate(m1, "1m", tf, to), source: "ticks" as const, requests: 0 };
}

/** Validated candles for [from, to) — `to` is the backtest end (no candle closing after it is "closed"). */
export async function loadHistory(args: {
  provider: string;
  symbol: string;
  timeframe: Timeframe;
  from: number;
  to: number;
  scope?: string;
  cancelled?: () => Promise<boolean>;
}): Promise<HistoryResult> {
  const p = getProvider(args.provider);
  if (!p) throw new MarketDataError(args.provider, "Unknown market-data provider");
  const tf = args.timeframe;
  let r: { candles: Candle[]; source: HistoryResult["source"]; requests: number };
  if (p.capabilities.candleTimeframes.includes(tf)) {
    r = await loadNative(p, args.symbol, tf, args.from, args.to, args.cancelled);
  } else {
    const lower = [...p.capabilities.candleTimeframes]
      .sort(compareTimeframes)
      .reverse()
      .find((l) => l !== tf && canAggregate(l, tf));
    if (lower) {
      const low = await loadNative(p, args.symbol, lower, args.from, args.to, args.cancelled);
      const norm = normalizeCandles(low.candles, lower, args.to);
      r = { candles: aggregate(norm.candles, lower, tf, args.to), source: "aggregated", requests: low.requests };
    } else r = await loadStored(p.key, args.scope, args.symbol, tf, args.from, args.to);
  }
  const { candles, issues } = normalizeCandles(r.candles, tf, args.to);
  return { candles, issues, source: r.source, requests: r.requests };
}
