import type { Candle } from "@/lib/market/candles";
import { bucketEnd, bucketStart, TIMEFRAMES, type Timeframe } from "@/lib/market/timeframes";
import type { CandleQuery, MarketDataProvider, SymbolRef } from "../types";

/**
 * Mock market-data provider (MARKET_DATA_PROVIDER=mock) for development, tests and demos — no credentials.
 *
 * DETERMINISTIC: the price is a pure function of (symbol, time), so the same candle is produced whether it
 * is requested live, by the simulator or by a backtest. That makes live/backtest consistency testable.
 * Synthetic data: health checks report it as SIMULATED, never as live market data.
 *
 *   p(t) = base · (1 + 0.004·sin(2πt/6h) + 0.002·sin(2πt/47m + φ₁) + 0.0008·sin(2πt/7m + φ₂) + 0.0003·n(minute))
 *
 * Candle open/close are p at the bucket boundaries (so consecutive candles connect), high/low are the
 * extremes of p sampled inside the bucket. Volume is a deterministic per-bucket number (volumeType REAL so
 * volume conditions can be exercised).
 */
const BASE: Record<string, number> = {
  XAUUSD: 3890,
  XAGUSD: 46.2,
  BTCUSD: 112000,
  ETHUSD: 4300,
  EURUSD: 1.172,
  GBPUSD: 1.346,
  USDJPY: 147.5,
  NAS100: 24600,
  US30: 46500,
  SPX500: 6700,
};

function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic value in [-1, 1] for (symbol, integer key). */
function noise(symbol: string, key: number) {
  let x = (hash32(symbol) ^ Math.imul(key | 0, 0x9e3779b1) ^ Math.imul(Math.floor(key / 4294967296), 0x85ebca6b)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; // keep unsigned: a signed result would push noise below -1 (negative volume)
  return (x / 4294967295) * 2 - 1;
}

export function basePrice(symbol: string) {
  if (BASE[symbol]) return BASE[symbol];
  return 10 + (hash32(symbol) % 9_000); // custom symbols still work in dev
}

const TAU = Math.PI * 2;

/** Mock price at instant t (epoch ms). */
export function mockPrice(symbol: string, t: number): number {
  const base = basePrice(symbol);
  const ph1 = (hash32(symbol) % 1000) / 159;
  const ph2 = (hash32(symbol + "x") % 1000) / 159;
  const m = Math.floor(t / 60_000);
  const frac = t / 60_000 - m;
  const n = noise(symbol, m) * (1 - frac) + noise(symbol, m + 1) * frac; // continuous between minutes
  const v =
    1 +
    0.004 * Math.sin((TAU * t) / 21_600_000) +
    0.002 * Math.sin((TAU * t) / 2_820_000 + ph1) +
    0.0008 * Math.sin((TAU * t) / 420_000 + ph2) +
    0.0003 * n;
  const decimals = base < 10 ? 5 : base < 1000 ? 3 : 2;
  return Number((base * v).toFixed(decimals));
}

/** One mock candle for [openTime, closeTime), observed at `asOf` (a forming candle only uses samples ≤ asOf). */
export function mockCandle(symbol: string, tf: Timeframe, openTime: number, asOf = Number.POSITIVE_INFINITY): Candle {
  const closeTime = bucketEnd(openTime, tf);
  const end = Math.min(closeTime, asOf);
  const samples = 24;
  let high = -Infinity;
  let low = Infinity;
  for (let k = 0; k <= samples; k++) {
    const p = mockPrice(symbol, openTime + ((end - openTime) * k) / samples);
    high = Math.max(high, p);
    low = Math.min(low, p);
  }
  const open = mockPrice(symbol, openTime);
  const close = mockPrice(symbol, end);
  const minutes = Math.max(1, (closeTime - openTime) / 60_000);
  const volume = Math.round(minutes * (500 + 400 * noise(symbol + "v", Math.floor(openTime / 60_000))));
  return {
    openTime,
    closeTime,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume: end < closeTime ? Math.round((volume * (end - openTime)) / (closeTime - openTime)) : volume,
    volumeType: "REAL",
    state: closeTime <= asOf ? "CLOSED" : "FORMING",
  };
}

export class SimulatedProvider implements MarketDataProvider {
  readonly label = "Mock (deterministic)";
  readonly description = "Synthetic, deterministic prices for testing without API credentials. Not real market data.";
  readonly capabilities = {
    realtime: "polling" as const,
    candleTimeframes: [...TIMEFRAMES],
    historyDays: 3650,
    volume: "REAL" as const,
    synthetic: true,
  };

  /** Registered twice: "mock" (spec name) and "simulated" (existing alerts). Same generator. */
  constructor(readonly key: "mock" | "simulated" = "mock") {}

  isConfigured() {
    return true;
  }

  async getPrice({ symbol }: SymbolRef) {
    return mockPrice(symbol, Date.now());
  }

  async getPrices(symbols: SymbolRef[]) {
    const now = Date.now();
    return new Map(symbols.map(({ symbol }) => [symbol, mockPrice(symbol, now)]));
  }

  async getCandles({ symbol }: SymbolRef, tf: Timeframe, q: CandleQuery): Promise<Candle[]> {
    const to = q.to ?? Date.now();
    const limit = Math.min(q.limit ?? 500, 5000);
    const out: Candle[] = [];
    let start = bucketStart(to - 1, tf);
    while (out.length < limit) {
      if (q.from !== undefined && start < q.from) break;
      out.push(mockCandle(symbol, tf, start, to));
      start = bucketStart(start - 1, tf);
    }
    return out.reverse();
  }
}

/** Kept for existing imports: current mock price. */
export function simulatedPrice(symbol: string, now = Date.now()) {
  return mockPrice(symbol, now);
}
