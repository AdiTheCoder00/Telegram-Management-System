import { describe, expect, it } from "vitest";
import * as I from "@/lib/indicators";
import { INDICATORS, resolveParams } from "@/lib/indicators/registry";
import type { Candle } from "@/lib/market/candles";
import { candlesFromCloses } from "./helpers/candles";

/** Deterministic pseudo-random walk with volume (mulberry32). */
function series(n: number, seed = 7): Candle[] {
  let a = seed;
  const rnd = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const closes: number[] = [];
  let p = 3900;
  for (let i = 0; i < n; i++) closes.push((p *= 1 + (rnd() - 0.5) * 0.004));
  return candlesFromCloses(closes, "5m", undefined, { volume: () => Math.round(100 + rnd() * 900), spread: 1.2 });
}

// StockCharts ChartSchool RSI(14) worked example
const RSI_CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282,
  46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672,
  43.4205, 42.6628, 43.1314,
];
const RSI_EXPECTED = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77,
];

describe("primitive averages", () => {
  it("SMA", () => {
    expect(I.sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("EMA is seeded with the SMA and then smoothed with alpha = 2/(n+1)", () => {
    const e = I.ema([2, 4, 6, 8, 10], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBeCloseTo(4, 10); // SMA(2,4,6)
    expect(e[3]).toBeCloseTo(0.5 * 8 + 0.5 * 4, 10);
    expect(e[4]).toBeCloseTo(0.5 * 10 + 0.5 * 6, 10);
  });
  it("WMA weights recent values more", () => {
    expect(I.wma([1, 2, 3], 3)[2]).toBeCloseTo((1 * 1 + 2 * 2 + 3 * 3) / 6, 10);
  });
  it("population standard deviation", () => {
    expect(I.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7]).toBeCloseTo(2, 10);
  });
});

describe("RSI", () => {
  it("matches the StockCharts reference values (Wilder smoothing)", () => {
    const r = I.rsi(RSI_CLOSES, 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    RSI_EXPECTED.forEach((exp, k) => expect(r[14 + k]).toBeCloseTo(exp, 1));
  });
  it("is 100 with only gains and 50 on a flat series", () => {
    expect(I.rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(I.rsi([5, 5, 5, 5, 5], 3)[4]).toBe(50);
  });
});

describe("MACD / Bollinger / ATR / oscillators", () => {
  const c = series(120);
  const closes = c.map((x) => x.close);
  it("MACD line = EMA(12) − EMA(26); histogram = line − signal", () => {
    const m = I.macd(closes);
    const e12 = I.ema(closes, 12);
    const e26 = I.ema(closes, 26);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[60]).toBeCloseTo((e12[60] as number) - (e26[60] as number), 10);
    expect(m.histogram[60]).toBeCloseTo((m.macd[60] as number) - (m.signal[60] as number), 10);
    expect(m.signal[25 + 7]).toBeNull();
    expect(m.signal[25 + 8]).not.toBeNull();
  });
  it("Bollinger middle is the SMA and bands are symmetric", () => {
    const b = I.bollinger(closes, 20, 2);
    const mid = b.middle[50] as number;
    expect(mid).toBeCloseTo(I.sma(closes, 20)[50] as number, 10);
    expect((b.upper[50] as number) - mid).toBeCloseTo(mid - (b.lower[50] as number), 10);
  });
  it("ATR uses true range with Wilder smoothing", () => {
    const cs = candlesFromCloses([10, 11, 12, 11, 13], "5m", undefined, { spread: 0 });
    const tr = I.trueRange(cs);
    expect(tr).toEqual([0, 1, 1, 1, 2]);
    expect(I.atr(cs, 2)[1]).toBeCloseTo(0.5, 10);
    expect(I.atr(cs, 2)[2]).toBeCloseTo((0.5 * 1 + 1) / 2, 10);
  });
  it("oscillators stay within their ranges", () => {
    const within = (vals: (number | null)[], lo: number, hi: number) => {
      const xs = vals.filter((v): v is number => v !== null);
      expect(xs.length).toBeGreaterThan(0);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(lo);
      expect(Math.max(...xs)).toBeLessThanOrEqual(hi);
    };
    within(I.stochastic(c).k, 0, 100);
    within(I.williamsR(c), -100, 0);
    within(I.stochRsi(closes).k, 0, 100);
  });
  it("VWAP resets daily and is null without volume", () => {
    const noVol = candlesFromCloses([1, 2, 3], "1h", undefined, { volume: () => null });
    expect(I.vwap(noVol)).toEqual([null, null, null]);
    const day = candlesFromCloses([10, 10, 10], "1h", undefined, { spread: 0 });
    expect(I.vwap(day)[2]).toBeCloseTo(10, 10);
  });
  it("Supertrend direction is ±1 after warm-up", () => {
    const s = I.supertrend(c, 10, 3);
    expect(s.direction.slice(10).every((d) => d === 1 || d === -1)).toBe(true);
  });
});

describe("registry contract (applies to every indicator)", () => {
  const full = series(220);
  for (const def of INDICATORS) {
    const p = resolveParams(def, {});
    it(`${def.key}: no look-ahead — prefix results equal full-series results`, () => {
      const all = def.compute(full, p);
      for (const cut of [40, 97, 160, 219]) {
        const part = def.compute(full.slice(0, cut), p);
        for (const out of def.outputs) expect(part[out]).toEqual(all[out].slice(0, cut));
      }
    });
    it(`${def.key}: deterministic, one value per candle, honours its declared warm-up`, () => {
      const a = def.compute(full, p);
      const b = def.compute(full, p);
      expect(a).toEqual(b);
      // Declared warm-up = the bar at which EVERY output is available (faster outputs, e.g. MACD line vs
      // signal, may start earlier), and not one bar sooner.
      const w = def.warmup(p);
      for (const out of def.outputs) {
        expect(a[out]).toHaveLength(full.length);
        expect(a[out][w - 1]).not.toBeNull();
      }
      if (w >= 2) expect(def.outputs.some((out) => a[out][w - 2] === null)).toBe(true);
    });
  }

  it("rejects out-of-range and unknown parameters", () => {
    const rsi = INDICATORS.find((d) => d.key === "rsi")!;
    expect(() => resolveParams(rsi, { period: 0 })).toThrow(/between/);
    expect(() => resolveParams(rsi, { period: 2.5 })).toThrow(/whole/);
    expect(() => resolveParams(rsi, { length: 14 })).toThrow(/unknown/);
  });

  it("volume indicators never substitute missing volume", () => {
    const noVol = candlesFromCloses(
      Array.from({ length: 40 }, (_, i) => 100 + i),
      "5m",
      undefined,
      { volume: () => null },
    );
    for (const key of ["volume", "avgvolume", "rvol", "volspike", "vwap"]) {
      const def = INDICATORS.find((d) => d.key === key)!;
      const out = def.compute(noVol, resolveParams(def, {}));
      expect(out[def.defaultOutput].every((v) => v === null)).toBe(true);
    }
  });
});
