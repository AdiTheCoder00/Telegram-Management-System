import type { Candle, VolumeType } from "@/lib/market/candles";
import { bucketEnd, type Timeframe } from "@/lib/market/timeframes";
import { MarketDataError, type CandleQuery, type MarketDataProvider, type SymbolRef } from "../types";

/**
 * Twelve Data REST API (https://twelvedata.com) — the initial production provider (M7).
 * Key: TWELVE_DATA_API_KEY (MARKET_DATA_API_KEY is accepted as a fallback). Keys never leave the server.
 *
 * Symbols: XAUUSD → XAU/USD; indices need an Instrument.providerSymbol (seeded: NAS100 → NDX, US30 → DJI).
 * Candles: /time_series with timezone=UTC, so returned datetimes are parsed as UTC (never reinterpreted).
 * The newest value is the still-forming bar; lifecycle is assigned by the caller from the bucket end.
 * Volume: present for crypto/equities (PROVIDER — semantics vary by venue), absent for FX (UNAVAILABLE).
 * Real-time: polling only (WebSocket streaming is a paid feature; see TODO in market-data docs).
 * 3m is not a native interval: it is aggregated from 1m by the market-data service.
 */
const BASE_URL = "https://api.twelvedata.com";

const INTERVAL: Partial<Record<Timeframe, string>> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "1d": "1day",
  "1w": "1week",
  "1M": "1month",
};

export function apiKey() {
  return process.env.TWELVE_DATA_API_KEY || process.env.MARKET_DATA_API_KEY || "";
}

export function toTwelveDataSymbol({ symbol, providerSymbol }: SymbolRef) {
  if (providerSymbol) return providerSymbol;
  if (/^[A-Z]{6}$/.test(symbol)) return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  return symbol;
}

/** "2026-10-03 14:35:00" or "2026-10-03" in UTC → epoch ms. Throws on anything else. */
export function parseUtc(dt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(dt.trim());
  if (!m) throw new MarketDataError("twelvedata", `Unrecognised datetime "${dt}"`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

const fmtUtc = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

export class TwelveDataProvider implements MarketDataProvider {
  readonly key = "twelvedata";
  readonly label = "Twelve Data";
  readonly description = "Forex, metals, indices and crypto via Twelve Data (API key required).";
  readonly capabilities = {
    realtime: "polling" as const,
    candleTimeframes: Object.keys(INTERVAL) as Timeframe[],
    historyDays: 3650,
    volume: "PROVIDER" as VolumeType,
  };

  isConfigured() {
    return !!apiKey();
  }

  private async request(path: string, params: Record<string, string>) {
    const key = apiKey();
    if (!key) throw new MarketDataError(this.key, "TWELVE_DATA_API_KEY is not configured");
    const qs = new URLSearchParams({ ...params, apikey: key });
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}?${qs}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    } catch {
      throw new MarketDataError(this.key, "Network error contacting Twelve Data");
    }
    if (res.status === 429) throw new MarketDataError(this.key, "Rate limit reached (HTTP 429)");
    if (!res.ok) throw new MarketDataError(this.key, `HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "error") {
      const code = Number(data.code);
      throw new MarketDataError(this.key, code === 429 ? "Rate limit reached" : String(data.message ?? "API error"));
    }
    return data;
  }

  async getPrice(ref: SymbolRef) {
    const p = (await this.getPrices([ref])).get(ref.symbol);
    if (p === undefined) throw new MarketDataError(this.key, `No price for ${ref.symbol}`);
    return p;
  }

  async getPrices(refs: SymbolRef[]) {
    const bySource = new Map(refs.map((r) => [toTwelveDataSymbol(r), r.symbol]));
    const data = await this.request("/price", { symbol: [...bySource.keys()].join(",") });
    const out = new Map<string, number>();
    // Single symbol → { price }, multiple → { "XAU/USD": { price }, ... }
    const entries: [string, unknown][] = bySource.size === 1 ? [[[...bySource.keys()][0], data]] : Object.entries(data);
    for (const [src, row] of entries) {
      const price = Number((row as { price?: string })?.price);
      const symbol = bySource.get(src);
      if (symbol && Number.isFinite(price) && price > 0) out.set(symbol, price);
    }
    return out;
  }

  async getCandles(ref: SymbolRef, tf: Timeframe, q: CandleQuery): Promise<Candle[]> {
    const interval = INTERVAL[tf];
    if (!interval) throw new MarketDataError(this.key, `Timeframe ${tf} is not available from Twelve Data`);
    const params: Record<string, string> = {
      symbol: toTwelveDataSymbol(ref),
      interval,
      timezone: "UTC",
      order: "ASC",
      outputsize: String(Math.min(q.limit ?? 500, 5000)),
    };
    if (q.from !== undefined) params.start_date = fmtUtc(q.from);
    if (q.to !== undefined) params.end_date = fmtUtc(q.to);
    const data = await this.request("/time_series", params);
    const values = (data.values as Record<string, string>[] | undefined) ?? [];
    return values.map((v) => {
      const openTime = parseUtc(v.datetime);
      const hasVol = v.volume !== undefined && v.volume !== "" && Number.isFinite(Number(v.volume));
      return {
        openTime,
        closeTime: bucketEnd(openTime, tf),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: hasVol ? Number(v.volume) : null,
        volumeType: hasVol ? "PROVIDER" : "UNAVAILABLE",
        state: "CLOSED", // re-derived by normalizeCandles from the bucket end
      } satisfies Candle;
    });
  }
}
