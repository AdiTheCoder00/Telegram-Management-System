import type { Candle, DataIssue } from "@/lib/market/candles";
import { bucketEnd, bucketStart, type Timeframe } from "@/lib/market/timeframes";

/**
 * Data freshness (spec 0.31). A series is judged by its latest CLOSED candle against the most recent bucket
 * that should have closed by `asOf`:
 *
 *   LIVE    — up to date and the current bucket is also present (forming)
 *   FRESH   — latest closed candle is the expected one (within the grace period)
 *   STALE   — the latest closed candle is older than expected → no new triggers from this series
 *   NO_DATA — nothing to evaluate
 *   INVALID — the provider returned future-dated data (clock/timestamp problem)
 *
 * Markets that are closed (weekends, holidays) also show as STALE — correctly: there is no new data to act on.
 */
export type FreshnessState = "LIVE" | "FRESH" | "STALE" | "NO_DATA" | "INVALID";

export interface Freshness {
  state: FreshnessState;
  latestClosedOpenTime: number | null;
  expectedClosedOpenTime: number;
  lagMs: number | null;
}

export const candleGraceMs = () => Math.max(10_000, Number(process.env.MARKET_DATA_CANDLE_GRACE_MS ?? 120_000));

export function computeFreshness(
  candles: Candle[],
  tf: Timeframe,
  asOf: number,
  issues: DataIssue[] = [],
  graceMs = candleGraceMs(),
): Freshness {
  const currentStart = bucketStart(asOf, tf);
  const expectedClosedOpenTime = bucketStart(currentStart - 1, tf);
  if (issues.some((i) => i.kind === "future")) return { state: "INVALID", latestClosedOpenTime: null, expectedClosedOpenTime, lagMs: null };
  let closed: Candle | undefined;
  let forming: Candle | undefined;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.closeTime <= asOf) {
      closed = c;
      break;
    }
    if (c.openTime === currentStart) forming = c;
  }
  if (!closed) return { state: "NO_DATA", latestClosedOpenTime: null, expectedClosedOpenTime, lagMs: null };
  // The candle after our latest closed one should have closed at bucketEnd(closed.closeTime).
  // Overdue by more than the grace period → the feed is behind (stale). Providers publish a closed bar a few
  // seconds after the boundary, so a small delay right after a close is normal and stays fresh.
  const overdueMs = asOf - bucketEnd(closed.closeTime, tf);
  const state: FreshnessState = overdueMs > graceMs ? "STALE" : forming ? "LIVE" : "FRESH";
  return { state, latestClosedOpenTime: closed.openTime, expectedClosedOpenTime, lagMs: Math.max(0, overdueMs) };
}
