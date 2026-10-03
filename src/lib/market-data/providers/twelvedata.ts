import { MarketDataError, type MarketDataProvider, type SymbolRef } from "../types";

/**
 * Twelve Data REST API (https://twelvedata.com) — forex, metals, indices, crypto. Requires MARKET_DATA_API_KEY.
 * XAUUSD → XAU/USD. Indices need an explicit providerSymbol on the Instrument (seeded for NAS100/US30).
 */
const BASE_URL = "https://api.twelvedata.com";

export function toTwelveDataSymbol({ symbol, providerSymbol }: SymbolRef) {
  if (providerSymbol) return providerSymbol;
  if (/^[A-Z]{6}$/.test(symbol)) return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  return symbol;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly key = "twelvedata";
  readonly label = "Twelve Data";
  readonly description = "Forex, metals, indices and crypto via Twelve Data (API key required).";

  isConfigured() {
    return !!process.env.MARKET_DATA_API_KEY;
  }

  async getPrice(ref: SymbolRef) {
    const p = (await this.getPrices([ref])).get(ref.symbol);
    if (p === undefined) throw new MarketDataError(this.key, `No price for ${ref.symbol}`);
    return p;
  }

  async getPrices(refs: SymbolRef[]) {
    const key = process.env.MARKET_DATA_API_KEY;
    if (!key) throw new MarketDataError(this.key, "MARKET_DATA_API_KEY is not configured");
    const bySource = new Map(refs.map((r) => [toTwelveDataSymbol(r), r.symbol]));
    const url = `${BASE_URL}/price?symbol=${encodeURIComponent([...bySource.keys()].join(","))}&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!res.ok) throw new MarketDataError(this.key, `HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "error") throw new MarketDataError(this.key, String(data.message ?? "API error"));

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
}
