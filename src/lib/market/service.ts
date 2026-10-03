import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getProvider } from "@/lib/market-data/registry";
import { MarketDataError, type MarketDataProvider, type SymbolRef } from "@/lib/market-data/types";
import { aggregate, normalizeCandles, type Candle, type DataIssue, type VolumeType } from "@/lib/market/candles";
import { computeFreshness, type Freshness } from "@/lib/market/freshness";
import { bucketStart, canAggregate, compareTimeframes, timeframeMs, type Timeframe } from "@/lib/market/timeframes";

/**
 * Market-data service (M7) — the ONLY way engines obtain candles.
 *
 *   provider (native timeframe)  ─▶ DB candle cache ─┐
 *   provider (lower timeframe)   ─▶ aggregate()  ────┼─▶ normalizeCandles() ─▶ canonical candles + issues + freshness
 *   price-only feeds (ticks)     ─▶ 1m tick candles ─┘
 *
 * Provider-specific formats never leave the provider class; validation (ordering, duplicates, OHLC, alignment,
 * future timestamps) happens here; nothing is silently repaired.
 */
export const GLOBAL = "global";

export interface SeriesRequest {
  provider: string;
  symbol: string;
  timeframe: Timeframe;
  asOf: number;
  /** Closed bars wanted before (and including) the current bar. */
  bars: number;
  /** User scope for user-pushed (webhook) feeds; falls back to the global feed. */
  scope?: string;
  /** Skip the cache freshness check and always ask the provider (simulator "refresh"). */
  forceRefresh?: boolean;
}

export interface SeriesResult {
  candles: Candle[];
  issues: DataIssue[];
  freshness: Freshness;
  source: "provider" | "aggregated" | "ticks" | "synthetic";
  provider: string;
  fetchedAt: string;
  /** Set when the provider failed and cached data was served instead. */
  providerError?: string;
}

async function symbolRef(symbol: string): Promise<SymbolRef> {
  const inst = await db.instrument.findUnique({ where: { symbol }, select: { providerSymbol: true } });
  return { symbol, providerSymbol: inst?.providerSymbol ?? null };
}

function rowToCandle(
  r: { openTime: Date; open: number; high: number; low: number; close: number; volume: number | null; volumeType: string },
  tf: Timeframe,
): Candle {
  const openTime = r.openTime.getTime();
  return {
    openTime,
    closeTime: openTime + timeframeMs(tf), // re-derived exactly by normalizeCandles
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    volumeType: r.volumeType as VolumeType,
    state: "CLOSED",
  };
}

// ─── provider health ─────────────────────────────────────────────────────────

export async function recordProviderSuccess(provider: string) {
  await db.providerHealth
    .upsert({
      where: { provider },
      create: { provider, lastSuccessAt: new Date(), consecutiveFailures: 0 },
      update: { lastSuccessAt: new Date(), consecutiveFailures: 0 },
    })
    .catch(() => undefined);
}

export async function recordProviderFailure(provider: string, error: string) {
  await db.providerHealth
    .upsert({
      where: { provider },
      create: { provider, lastErrorAt: new Date(), lastError: error.slice(0, 500), consecutiveFailures: 1 },
      update: { lastErrorAt: new Date(), lastError: error.slice(0, 500), consecutiveFailures: { increment: 1 } },
    })
    .catch(() => undefined);
}

/** Per-provider request budget (Twelve Data free tier: 8/min). Shared across processes when Redis is set. */
async function allowRequest(p: MarketDataProvider) {
  if (p.capabilities.synthetic) return true;
  const perMin = Number(p.key === "twelvedata" ? (process.env.TWELVE_DATA_RATE_LIMIT_PER_MIN ?? 8) : 60);
  return (await rateLimit(`provider:${p.key}`, perMin, 60_000)).ok;
}

// ─── native candles with DB cache ────────────────────────────────────────────

async function nativeCandles(p: MarketDataProvider, symbol: string, tf: Timeframe, asOf: number, bars: number, force: boolean) {
  const ref = await symbolRef(symbol);
  if (p.capabilities.synthetic) {
    // Deterministic generator: no cache needed, never stale.
    return { candles: await p.getCandles!(ref, tf, { to: asOf, limit: bars + 1 }), source: "synthetic" as const, providerError: undefined };
  }

  const cached = (
    await db.candle.findMany({
      where: { provider: p.key, scope: GLOBAL, symbol, timeframe: tf, openTime: { lte: new Date(asOf) } },
      orderBy: { openTime: "desc" },
      take: bars + 1,
    })
  )
    .reverse()
    .map((r) => rowToCandle(r, tf));

  const currentStart = bucketStart(asOf, tf);
  const expectedLastClosed = bucketStart(currentStart - 1, tf);
  const lastCachedClosed = [...cached].reverse().find((c) => c.openTime + timeframeMs(tf) <= asOf);
  const haveEnough = cached.length >= bars;
  const upToDate = !!lastCachedClosed && lastCachedClosed.openTime >= expectedLastClosed;
  // Backtests ask for the past (asOf well behind now): cached history is final, never refetched.
  const historical = asOf < Date.now() - 2 * timeframeMs(tf);
  if (!force && haveEnough && (upToDate || historical)) return { candles: cached, source: "provider" as const, providerError: undefined };

  if (!(await allowRequest(p))) {
    return { candles: cached, source: "provider" as const, providerError: "Provider request budget exhausted; serving cached candles." };
  }
  // Fetch only what's missing when the cache is warm; the full window otherwise.
  const missing = lastCachedClosed ? Math.ceil((currentStart - lastCachedClosed.openTime) / timeframeMs(tf)) + 1 : bars + 1;
  const limit = Math.min(5000, haveEnough ? Math.max(2, missing) : bars + 1);
  try {
    const fetched = await p.getCandles!(ref, tf, { to: asOf, limit });
    await recordProviderSuccess(p.key);
    const now = Date.now();
    await db.$transaction(
      fetched
        .filter((c) => c.openTime <= now)
        .map((c) =>
          db.candle.upsert({
            where: {
              provider_scope_symbol_timeframe_openTime: {
                provider: p.key,
                scope: GLOBAL,
                symbol,
                timeframe: tf,
                openTime: new Date(c.openTime),
              },
            },
            create: {
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
            },
            update: {
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              volumeType: c.volumeType,
              closed: c.closeTime <= now,
            },
          }),
        ),
    );
    const merged = new Map<number, Candle>(cached.map((c) => [c.openTime, c]));
    for (const c of fetched) merged.set(c.openTime, c);
    return {
      candles: [...merged.values()].sort((a, b) => a.openTime - b.openTime).slice(-(bars + 1)),
      source: "provider" as const,
      providerError: undefined,
    };
  } catch (err) {
    const msg = err instanceof MarketDataError ? err.message : "Provider request failed";
    await recordProviderFailure(p.key, msg);
    logger.warn("Market data fetch failed; serving cache", { provider: p.key, symbol, tf, err: msg });
    if (!cached.length) throw err;
    return { candles: cached, source: "provider" as const, providerError: msg };
  }
}

// ─── candles built from price ticks (webhook / price-only providers) ─────────

/** Upserts the 1m tick candle for a price tick (called by the price engine for every accepted tick). */
export async function recordTickCandle(provider: string, scope: string, symbol: string, price: number, time: Date) {
  const openTime = new Date(bucketStart(time.getTime(), "1m"));
  const now = new Date();
  await db.$executeRaw`
    INSERT INTO "Candle" ("provider","scope","symbol","timeframe","openTime","open","high","low","close","volume","volumeType","closed","updatedAt")
    VALUES (${provider}, ${scope}, ${symbol}, '1m', ${openTime}, ${price}, ${price}, ${price}, ${price}, 1, 'TICK', false, ${now})
    ON CONFLICT ("provider","scope","symbol","timeframe","openTime") DO UPDATE SET
      "high" = GREATEST("Candle"."high", EXCLUDED."high"),
      "low" = LEAST("Candle"."low", EXCLUDED."low"),
      "close" = EXCLUDED."close",
      "volume" = COALESCE("Candle"."volume", 0) + 1,
      "updatedAt" = EXCLUDED."updatedAt"`;
}

async function tickCandles(provider: string, scope: string | undefined, symbol: string, tf: Timeframe, asOf: number, bars: number) {
  const ratio = Math.max(1, Math.round(timeframeMs(tf) / 60_000));
  const take = Math.min(20_000, (bars + 1) * ratio);
  const load = (s: string) =>
    db.candle.findMany({
      where: { provider, scope: s, symbol, timeframe: "1m", openTime: { lte: new Date(asOf) } },
      orderBy: { openTime: "desc" },
      take,
    });
  // A user's own pushed feed takes precedence over the shared feed.
  let rows = scope && scope !== GLOBAL ? await load(scope) : [];
  if (!rows.length) rows = await load(GLOBAL);
  const m1 = rows.reverse().map((r) => rowToCandle(r, "1m"));
  return tf === "1m" ? m1 : aggregate(m1, "1m", tf, asOf);
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Canonical, validated candles for one (provider, symbol, timeframe) at `asOf`. */
export async function getSeries(req: SeriesRequest): Promise<SeriesResult> {
  const p = getProvider(req.provider);
  if (!p) throw new MarketDataError(req.provider, "Unknown market-data provider");
  const tf = req.timeframe;
  let raw: Candle[];
  let source: SeriesResult["source"];
  let providerError: string | undefined;

  if (p.capabilities.candleTimeframes.includes(tf)) {
    const r = await nativeCandles(p, req.symbol, tf, req.asOf, req.bars, !!req.forceRefresh);
    raw = r.candles;
    source = r.source;
    providerError = r.providerError;
  } else {
    const lower = [...p.capabilities.candleTimeframes]
      .sort(compareTimeframes)
      .reverse()
      .find((l) => canAggregate(l, tf) && l !== tf);
    if (lower) {
      const ratio = Math.ceil(timeframeMs(tf) / timeframeMs(lower));
      const r = await nativeCandles(p, req.symbol, lower, req.asOf, Math.min(5000, (req.bars + 1) * ratio), !!req.forceRefresh);
      const norm = normalizeCandles(r.candles, lower, req.asOf);
      raw = aggregate(norm.candles, lower, tf, req.asOf);
      source = "aggregated";
      providerError = r.providerError;
    } else {
      raw = await tickCandles(p.key, req.scope, req.symbol, tf, req.asOf, req.bars);
      source = "ticks";
    }
  }

  const { candles, issues } = normalizeCandles(raw, tf, req.asOf);
  return {
    candles,
    issues,
    freshness: computeFreshness(candles, tf, req.asOf, issues),
    source,
    provider: p.key,
    fetchedAt: new Date().toISOString(),
    providerError,
  };
}

/** Prunes tick candles and cached provider candles beyond retention (worker, hourly). */
export async function pruneCandles(tickRetentionDays = 30, cacheRetentionDays = 400) {
  const ticks = await db.candle.deleteMany({
    where: { volumeType: "TICK", openTime: { lt: new Date(Date.now() - tickRetentionDays * 86_400_000) } },
  });
  const cache = await db.candle.deleteMany({
    where: { volumeType: { not: "TICK" }, openTime: { lt: new Date(Date.now() - cacheRetentionDays * 86_400_000) } },
  });
  return ticks.count + cache.count;
}
