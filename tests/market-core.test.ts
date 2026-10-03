import { describe, expect, it } from "vitest";
import { aggregate, closedAt, normalizeCandles, TickCandleBuilder, type Candle } from "@/lib/market/candles";
import { bucketEnd, bucketStart, canAggregate } from "@/lib/market/timeframes";
import { matchPattern } from "@/lib/market/patterns";
import { inSession, SESSION_DEFS } from "@/lib/market/sessions";
import { candle, candlesFromCloses } from "./helpers/candles";

const T = (iso: string) => Date.parse(iso);

describe("timeframes (UTC buckets)", () => {
  it("aligns intraday buckets to the UTC epoch", () => {
    expect(bucketStart(T("2026-10-05T14:37:12Z"), "5m")).toBe(T("2026-10-05T14:35:00Z"));
    expect(bucketStart(T("2026-10-05T14:37:12Z"), "4h")).toBe(T("2026-10-05T12:00:00Z"));
    expect(bucketEnd(T("2026-10-05T12:00:00Z"), "4h")).toBe(T("2026-10-05T16:00:00Z"));
  });
  it("starts weeks on Monday and months on the 1st (UTC)", () => {
    expect(bucketStart(T("2026-10-08T10:00:00Z"), "1w")).toBe(T("2026-10-05T00:00:00Z")); // Thu → Mon
    expect(bucketStart(T("2026-10-04T23:59:00Z"), "1w")).toBe(T("2026-09-28T00:00:00Z")); // Sun → previous Mon
    expect(bucketStart(T("2026-10-31T23:00:00Z"), "1M")).toBe(T("2026-10-01T00:00:00Z"));
    expect(bucketEnd(T("2026-02-01T00:00:00Z"), "1M")).toBe(T("2026-03-01T00:00:00Z"));
  });
  it("knows which timeframes can be aggregated", () => {
    expect(canAggregate("1m", "5m")).toBe(true);
    expect(canAggregate("5m", "1h")).toBe(true);
    expect(canAggregate("1h", "1d")).toBe(true);
    expect(canAggregate("1d", "1M")).toBe(true);
    expect(canAggregate("1h", "5m")).toBe(false);
  });
});

describe("candle normalisation (data quality)", () => {
  const asOf = T("2026-10-05T12:00:00Z");
  const base = candlesFromCloses([1, 2, 3, 4], "5m", T("2026-10-05T11:00:00Z"));

  it("sorts out-of-order candles and reports it", () => {
    const r = normalizeCandles([base[2], base[0], base[1], base[3]], "5m", asOf);
    expect(r.candles.map((c) => c.close)).toEqual([1, 2, 3, 4]);
    expect(r.issues.map((i) => i.kind)).toContain("out_of_order");
  });
  it("collapses duplicates (keeping the latest) and reports them", () => {
    const dup = { ...base[1], close: 2.5, high: 3 };
    const r = normalizeCandles([base[0], base[1], dup, base[2]], "5m", asOf);
    expect(r.candles).toHaveLength(3);
    expect(r.candles[1].close).toBe(2.5);
    expect(r.issues.some((i) => i.kind === "duplicate")).toBe(true);
  });
  it("reports gaps without inventing candles", () => {
    const r = normalizeCandles([base[0], base[3]], "5m", asOf);
    expect(r.candles).toHaveLength(2);
    expect(r.issues.find((i) => i.kind === "gap")?.detail).toMatch(/missing/);
  });
  it("drops invalid OHLC, misaligned and future candles", () => {
    const bad = { ...base[1], high: 0.5 }; // high below close
    const mis = { ...base[2], openTime: base[2].openTime + 1000 };
    const fut = candlesFromCloses([9], "5m", asOf + 3_600_000)[0];
    const r = normalizeCandles([base[0], bad, mis, fut], "5m", asOf);
    expect(r.candles).toHaveLength(1);
    expect(r.issues.map((i) => i.kind).sort()).toEqual(["future", "gap", "invalid_ohlc", "misaligned"].sort().filter((k) => k !== "gap"));
  });
  it("sets lifecycle from the evaluation instant: the current bucket is FORMING", () => {
    const r = normalizeCandles(base, "5m", T("2026-10-05T11:17:00Z"));
    expect(r.candles.map((c) => c.state)).toEqual(["CLOSED", "CLOSED", "CLOSED", "FORMING"]);
  });
});

describe("aggregation", () => {
  const m1 = candlesFromCloses([10, 11, 12, 13, 14, 15, 16], "1m", T("2026-10-05T10:00:00Z"));
  it("builds 5m candles from 1m with correct OHLC and volume", () => {
    const m5 = aggregate(m1, "1m", "5m", T("2026-10-05T10:07:00Z"));
    expect(m5).toHaveLength(2);
    expect(m5[0]).toMatchObject({ open: 10, close: 14, high: 14.5, low: 9.5, volume: 500, state: "CLOSED" });
    expect(m5[1].state).toBe("FORMING");
  });
  it("never includes lower candles that start after asOf (no look-ahead)", () => {
    const m5 = aggregate(m1, "1m", "5m", T("2026-10-05T10:03:00Z"));
    expect(m5).toHaveLength(1);
    expect(m5[0].close).toBe(12);
    expect(m5[0].state).toBe("FORMING");
  });
  it("marks volume UNAVAILABLE when constituent volume types differ", () => {
    const mixed: Candle[] = m1.slice(0, 5).map((c, i) => ({ ...c, volumeType: i === 2 ? "TICK" : "REAL" }));
    expect(aggregate(mixed, "1m", "5m", T("2026-10-05T11:00:00Z"))[0]).toMatchObject({ volumeType: "UNAVAILABLE", volume: null });
  });
  it("closedAt() keeps only fully closed candles", () => {
    expect(closedAt(m1, T("2026-10-05T10:03:30Z"))).toHaveLength(3);
  });
  it("builds candles from ticks with tick-count volume", () => {
    const b = new TickCandleBuilder("1m");
    b.add(10, T("2026-10-05T10:00:05Z"));
    b.add(12, T("2026-10-05T10:00:30Z"));
    b.add(9, T("2026-10-05T10:00:55Z"));
    b.add(11, T("2026-10-05T10:01:10Z"));
    const s = b.snapshot(T("2026-10-05T10:01:20Z"));
    expect(s[0]).toMatchObject({ open: 10, high: 12, low: 9, close: 9, volume: 3, volumeType: "TICK", state: "CLOSED" });
    expect(s[1].state).toBe("FORMING");
  });
});

describe("candle patterns", () => {
  const at = (cs: Candle[], p: Parameters<typeof matchPattern>[2]) => matchPattern(cs, cs.length - 1, p);
  it("bullish / bearish / doji", () => {
    expect(at([candle({ open: 1, high: 2.2, low: 0.9, close: 2 })], "bullish")).toBe(true);
    expect(at([candle({ open: 2, high: 2.2, low: 0.9, close: 1 })], "bearish")).toBe(true);
    expect(at([candle({ open: 1, high: 2, low: 0, close: 1.05 })], "doji")).toBe(true);
    expect(at([candle({ open: 1, high: 1, low: 1, close: 1 })], "doji")).toBeNull(); // zero range
  });
  it("engulfing", () => {
    const prev = candle({ open: 10, high: 10.2, low: 8.8, close: 9 });
    const cur = candle({ open: 8.9, high: 10.6, low: 8.7, close: 10.5 }, prev.openTime + 300_000);
    expect(at([prev, cur], "bullish_engulfing")).toBe(true);
    expect(at([prev, cur], "bearish_engulfing")).toBe(false);
    expect(at([cur], "bullish_engulfing")).toBeNull(); // needs previous bar
  });
  it("hammer and shooting star", () => {
    expect(at([candle({ open: 9.8, high: 10, low: 8, close: 9.9 })], "hammer")).toBe(true);
    expect(at([candle({ open: 8.2, high: 10, low: 8, close: 8.1 })], "shooting_star")).toBe(true);
  });
  it("inside / outside bars and swing structure", () => {
    const prev = candle({ open: 10, high: 12, low: 8, close: 11 });
    const inside = candle({ open: 10, high: 11, low: 9, close: 10.5 }, prev.openTime + 300_000);
    const outside = candle({ open: 10, high: 13, low: 7, close: 12 }, prev.openTime + 300_000);
    expect(at([prev, inside], "inside_bar")).toBe(true);
    expect(at([prev, outside], "outside_bar")).toBe(true);
    expect(at([prev, outside], "higher_high")).toBe(true);
    expect(at([prev, outside], "lower_low")).toBe(true);
    expect(at([prev, inside], "higher_low")).toBe(true);
    expect(at([prev, inside], "lower_high")).toBe(true);
  });
  it("volume increasing / decreasing — never with unavailable volume", () => {
    const up = candlesFromCloses([1, 2, 3, 4], "5m", undefined, { volume: (i) => 100 + i * 10 });
    expect(at(up, "volume_increasing")).toBe(true);
    expect(at(up, "volume_decreasing")).toBe(false);
    const none = candlesFromCloses([1, 2, 3, 4], "5m", undefined, { volume: () => null });
    expect(at(none, "volume_increasing")).toBeNull();
  });
});

describe("sessions and DST", () => {
  it("London follows BST: 07:30 UTC is outside in winter, inside in summer", () => {
    expect(inSession(T("2026-01-14T07:30:00Z"), SESSION_DEFS.LONDON)).toBe(false); // 07:30 GMT
    expect(inSession(T("2026-07-15T07:30:00Z"), SESSION_DEFS.LONDON)).toBe(true); // 08:30 BST
  });
  it("handles the DST switch day itself (UK clocks change 2026-03-29 01:00 UTC)", () => {
    expect(inSession(T("2026-03-27T07:30:00Z"), SESSION_DEFS.LONDON)).toBe(false); // Fri before: GMT
    expect(inSession(T("2026-03-30T07:30:00Z"), SESSION_DEFS.LONDON)).toBe(true); // Mon after: BST
  });
  it("New York follows EDT/EST", () => {
    expect(inSession(T("2026-01-14T13:00:00Z"), SESSION_DEFS.NEW_YORK)).toBe(true); // 08:00 EST
    expect(inSession(T("2026-01-14T12:30:00Z"), SESSION_DEFS.NEW_YORK)).toBe(false); // 07:30 EST
    expect(inSession(T("2026-07-15T12:30:00Z"), SESSION_DEFS.NEW_YORK)).toBe(true); // 08:30 EDT
  });
  it("Tokyo (no DST) and weekends", () => {
    expect(inSession(T("2026-10-05T00:30:00Z"), SESSION_DEFS.ASIA)).toBe(true); // Mon 09:30 JST
    expect(inSession(T("2026-10-04T00:30:00Z"), SESSION_DEFS.ASIA)).toBe(false); // Sun
  });
  it("overnight custom sessions belong to the day they started", () => {
    const night = { name: "Night", timezone: "UTC", start: "22:00", end: "02:00", days: [5] }; // Friday night only
    expect(inSession(T("2026-10-09T23:00:00Z"), night)).toBe(true); // Fri 23:00
    expect(inSession(T("2026-10-10T01:00:00Z"), night)).toBe(true); // Sat 01:00 → Friday's session
    expect(inSession(T("2026-10-11T01:00:00Z"), night)).toBe(false); // Sun 01:00 → Saturday's (not traded)
  });
});
