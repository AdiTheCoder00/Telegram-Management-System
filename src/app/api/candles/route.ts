import { z } from "zod";
import { route, parseQuery } from "@/lib/api";
import { badRequest } from "@/lib/errors";
import { symbolSchema } from "@/lib/validation";
import { TIMEFRAMES, timeframeMs } from "@/lib/market/timeframes";
import { isValidProvider } from "@/lib/market-data/registry";
import { getSeries } from "@/lib/market/service";
import { loadHistory } from "@/lib/backtest/history";

const schema = z.object({
  provider: z.string().max(40),
  symbol: symbolSchema,
  timeframe: z.enum(TIMEFRAMES),
  /** live: the latest `bars` candles through the live market-data service (freshness included). */
  bars: z.coerce.number().int().min(10).max(2000).optional(),
  /** range: historical candles for a backtest chart. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const MAX_RANGE_BARS = 20_000;

/** GET /api/candles — canonical candles for charts (same sources and validation as the engines). */
export const GET = route(
  async ({ req, user }) => {
    const q = parseQuery(req, schema);
    if (!isValidProvider(q.provider)) throw badRequest("Unknown market-data provider.");
    const scope = q.provider === "webhook" ? user.id : undefined;
    if (q.from && q.to) {
      const from = q.from.getTime();
      const to = Math.min(q.to.getTime(), Date.now());
      if ((to - from) / timeframeMs(q.timeframe) > MAX_RANGE_BARS)
        throw badRequest(`Too many candles for a chart (max ${MAX_RANGE_BARS}).`);
      const h = await loadHistory({ provider: q.provider, symbol: q.symbol, timeframe: q.timeframe, from, to, scope });
      return { candles: h.candles, issues: h.issues.length, source: h.source, freshness: null };
    }
    const s = await getSeries({
      provider: q.provider,
      symbol: q.symbol,
      timeframe: q.timeframe,
      asOf: Date.now(),
      bars: q.bars ?? 300,
      scope,
    });
    return { candles: s.candles, issues: s.issues.length, source: s.source, freshness: s.freshness };
  },
  { rateLimit: [120, 60_000], bucket: "candles" },
);
