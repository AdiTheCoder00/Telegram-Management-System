import { bucketEnd, bucketStart, canAggregate, isAligned, type Timeframe } from "@/lib/market/timeframes";

/**
 * Canonical candle model. Every engine (indicators, conditions, simulator, backtest, charts) consumes this
 * shape only — never provider-specific formats.
 *
 * Lifecycle: FORMING (bucket still open) → CLOSED (bucket ended; values final) | INVALID (failed validation).
 * Volume semantics are explicit and never silently substituted (REAL exchange volume, TICK counts, PROVIDER-
 * reported volume of unknown nature, or UNAVAILABLE).
 */
export type CandleState = "FORMING" | "CLOSED" | "INVALID";
export type VolumeType = "REAL" | "TICK" | "PROVIDER" | "UNAVAILABLE";

export interface Candle {
  openTime: number; // epoch ms, UTC, aligned to the timeframe
  closeTime: number; // exclusive end
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  volumeType: VolumeType;
  state: CandleState;
}

export type DataIssueKind = "duplicate" | "out_of_order" | "gap" | "invalid_ohlc" | "misaligned" | "future" | "non_finite";

export interface DataIssue {
  kind: DataIssueKind;
  openTime: number;
  detail: string;
}

/** Validates a single candle's OHLC invariants. */
export function ohlcProblems(c: Pick<Candle, "open" | "high" | "low" | "close" | "volume">): string | null {
  const vals = [c.open, c.high, c.low, c.close];
  if (vals.some((v) => !Number.isFinite(v))) return "non-finite price";
  if (vals.some((v) => v <= 0)) return "non-positive price";
  if (c.high < Math.max(c.open, c.close, c.low)) return "high below open/close/low";
  if (c.low > Math.min(c.open, c.close, c.high)) return "low above open/close/high";
  if (c.volume !== null && (!Number.isFinite(c.volume) || c.volume < 0)) return "invalid volume";
  return null;
}

/** Candle lifecycle state at time `asOf`: FORMING until the bucket has ended. */
export function lifecycleAt(closeTime: number, asOf: number): CandleState {
  return closeTime <= asOf ? "CLOSED" : "FORMING";
}

export interface NormalizeResult {
  candles: Candle[];
  issues: DataIssue[];
}

/**
 * Normalises a raw candle list for a timeframe: sorts, removes exact duplicates (keeping the last copy),
 * marks invalid OHLC as INVALID (excluded from the result), rejects misaligned and future-dated candles,
 * sets lifecycle from `asOf`, and reports gaps. Nothing is silently repaired: every change is in `issues`.
 */
export function normalizeCandles(raw: Candle[], tf: Timeframe, asOf: number, maxFutureSkewMs = 60_000): NormalizeResult {
  const issues: DataIssue[] = [];
  const sorted = [...raw];
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].openTime < raw[i - 1].openTime) {
      issues.push({ kind: "out_of_order", openTime: raw[i].openTime, detail: "candles were not in time order; sorted" });
      break;
    }
  }
  sorted.sort((a, b) => a.openTime - b.openTime);

  const out: Candle[] = [];
  for (const c of sorted) {
    if (!isAligned(c.openTime, tf)) {
      issues.push({ kind: "misaligned", openTime: c.openTime, detail: `openTime not aligned to ${tf}` });
      continue;
    }
    if (c.openTime > asOf + maxFutureSkewMs) {
      issues.push({ kind: "future", openTime: c.openTime, detail: "candle opens in the future" });
      continue;
    }
    const problem = ohlcProblems(c);
    if (problem) {
      issues.push({ kind: problem === "non-finite price" ? "non_finite" : "invalid_ohlc", openTime: c.openTime, detail: problem });
      continue;
    }
    const closeTime = bucketEnd(c.openTime, tf);
    const candle: Candle = { ...c, closeTime, state: lifecycleAt(closeTime, asOf) };
    const last = out[out.length - 1];
    if (last && last.openTime === candle.openTime) {
      issues.push({ kind: "duplicate", openTime: candle.openTime, detail: "duplicate candle; kept the latest copy" });
      out[out.length - 1] = candle;
      continue;
    }
    if (last && candle.openTime !== last.closeTime) {
      issues.push({
        kind: "gap",
        openTime: last.closeTime,
        detail: `missing candle(s) between ${iso(last.closeTime)} and ${iso(candle.openTime)}`,
      });
    }
    out.push(candle);
  }
  return { candles: out, issues };
}

const iso = (t: number) => new Date(t).toISOString();

/**
 * Aggregates lower-timeframe candles into a higher timeframe.
 * A higher candle is CLOSED only when its whole bucket has ended at `asOf`; otherwise FORMING.
 * Volume: summed only if every constituent has the same non-UNAVAILABLE type, else UNAVAILABLE.
 */
export function aggregate(lower: Candle[], from: Timeframe, to: Timeframe, asOf: number): Candle[] {
  if (from === to) return lower.map((c) => ({ ...c, state: c.state === "INVALID" ? "INVALID" : lifecycleAt(c.closeTime, asOf) }));
  if (!canAggregate(from, to)) throw new Error(`Cannot aggregate ${from} candles into ${to}`);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let volType: VolumeType | null = null;
  for (const c of lower) {
    if (c.state === "INVALID" || c.openTime >= asOf) continue; // never use data from the future
    const start = bucketStart(c.openTime, to);
    if (!cur || cur.openTime !== start) {
      if (cur) out.push(finish(cur, volType, asOf));
      cur = {
        openTime: start,
        closeTime: bucketEnd(start, to),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        volumeType: c.volumeType,
        state: "FORMING",
      };
      volType = c.volumeType;
      continue;
    }
    cur.high = Math.max(cur.high, c.high);
    cur.low = Math.min(cur.low, c.low);
    cur.close = c.close;
    if (volType !== c.volumeType) volType = "UNAVAILABLE";
    cur.volume = cur.volume !== null && c.volume !== null ? cur.volume + c.volume : null;
    // A lower candle that is itself still forming makes the aggregate forming too.
    if (c.state === "FORMING") cur.state = "FORMING";
  }
  if (cur) out.push(finish(cur, volType, asOf));
  return out;
}

function finish(c: Candle, volType: VolumeType | null, asOf: number): Candle {
  const vt = volType ?? "UNAVAILABLE";
  return {
    ...c,
    volumeType: vt,
    volume: vt === "UNAVAILABLE" ? null : c.volume,
    state: c.state === "FORMING" && c.closeTime > asOf ? "FORMING" : lifecycleAt(c.closeTime, asOf),
  };
}

/** Builds 1-minute candles from price ticks (webhook / polled feeds). Volume is the tick count. */
export class TickCandleBuilder {
  private candles = new Map<number, Candle>();

  constructor(private tf: Timeframe = "1m") {}

  add(price: number, at: number) {
    if (!Number.isFinite(price) || price <= 0) return;
    const start = bucketStart(at, this.tf);
    const c = this.candles.get(start);
    if (!c) {
      this.candles.set(start, {
        openTime: start,
        closeTime: bucketEnd(start, this.tf),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        volumeType: "TICK",
        state: "FORMING",
      });
      return;
    }
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume = (c.volume ?? 0) + 1;
  }

  snapshot(asOf: number): Candle[] {
    return [...this.candles.values()].sort((a, b) => a.openTime - b.openTime).map((c) => ({ ...c, state: lifecycleAt(c.closeTime, asOf) }));
  }
}

/** Only candles whose data was fully known at `asOf` (the no-look-ahead filter). */
export function closedAt(candles: Candle[], asOf: number): Candle[] {
  return candles.filter((c) => c.state !== "INVALID" && c.closeTime <= asOf);
}
