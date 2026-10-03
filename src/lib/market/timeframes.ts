/**
 * Canonical timeframes. All bucketing is done in UTC on epoch milliseconds.
 *
 * Bucket rules (documented in docs/candle-semantics.md):
 *  - intraday (1m … 4h): aligned to the UTC epoch, e.g. 4h buckets start 00:00, 04:00, … UTC
 *  - 1d: UTC midnight to midnight
 *  - 1w: Monday 00:00 UTC to the next Monday
 *  - 1M: first day of the month 00:00 UTC to the first of the next month
 * A candle covers [openTime, closeTime) — closeTime is exclusive and equals the next candle's openTime.
 */
export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const MIN = 60_000;
const FIXED_MS: Partial<Record<Timeframe, number>> = {
  "1m": MIN,
  "3m": 3 * MIN,
  "5m": 5 * MIN,
  "15m": 15 * MIN,
  "30m": 30 * MIN,
  "1h": 60 * MIN,
  "2h": 120 * MIN,
  "4h": 240 * MIN,
  "1d": 1440 * MIN,
};

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1m": "1 minute",
  "3m": "3 minutes",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
  "2h": "2 hours",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
  "1M": "1 month",
};

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === "string" && (TIMEFRAMES as readonly string[]).includes(v);
}

/** Nominal duration (used for ordering and lookback sizing; months are approximated as 30 days). */
export function timeframeMs(tf: Timeframe): number {
  if (tf === "1w") return 7 * 1440 * MIN;
  if (tf === "1M") return 30 * 1440 * MIN;
  return FIXED_MS[tf]!;
}

/** Start (inclusive) of the bucket containing `t`. */
export function bucketStart(t: number, tf: Timeframe): number {
  const fixed = FIXED_MS[tf];
  if (fixed) return Math.floor(t / fixed) * fixed;
  const d = new Date(t);
  if (tf === "1w") {
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return day - dow * 1440 * MIN;
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); // 1M
}

/** End (exclusive) of the bucket that starts at `start`. */
export function bucketEnd(start: number, tf: Timeframe): number {
  const fixed = FIXED_MS[tf];
  if (fixed) return start + fixed;
  if (tf === "1w") return start + 7 * 1440 * MIN;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function isAligned(t: number, tf: Timeframe) {
  return bucketStart(t, tf) === t;
}

/** True when `lower` buckets nest exactly inside `higher` buckets (needed to aggregate). */
export function canAggregate(lower: Timeframe, higher: Timeframe) {
  if (lower === higher) return true;
  if (timeframeMs(lower) >= timeframeMs(higher)) return false;
  if (higher === "1M" || higher === "1w") return timeframeMs(lower) <= timeframeMs("1d") && 1440 % (timeframeMs(lower) / MIN) === 0;
  return timeframeMs(higher) % timeframeMs(lower) === 0;
}

export function compareTimeframes(a: Timeframe, b: Timeframe) {
  return timeframeMs(a) - timeframeMs(b);
}
