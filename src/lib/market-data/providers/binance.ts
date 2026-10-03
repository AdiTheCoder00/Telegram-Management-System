import { MarketDataError, type MarketDataProvider, type SymbolRef } from "../types";

/**
 * Binance public REST API (no key required) — crypto only.
 * BTCUSD is mapped to BTCUSDT unless an explicit providerSymbol is configured on the Instrument.
 * TODO(websocket): implement subscribe() with wss://stream.binance.com:9443/stream?streams=<sym>@miniTicker
 */
const BASE_URL = "https://api.binance.com/api/v3";

export function toBinanceSymbol({ symbol, providerSymbol }: SymbolRef) {
  if (providerSymbol) return providerSymbol.toUpperCase();
  const s = symbol.replace(/[^A-Z0-9]/g, "");
  return s.endsWith("USD") ? `${s}T` : s;
}

export class BinanceProvider implements MarketDataProvider {
  readonly key = "binance";
  readonly label = "Binance";
  readonly description = "Live crypto prices from Binance spot (BTCUSD → BTCUSDT).";
  /** Price-only source: candles for condition alerts are built from its ticks (volume = tick count). */
  readonly capabilities = { realtime: "polling" as const, candleTimeframes: [], historyDays: 0, volume: "TICK" as const };

  isConfigured() {
    return true;
  }

  async getPrice(ref: SymbolRef) {
    const prices = await this.getPrices([ref]);
    const p = prices.get(ref.symbol);
    if (p === undefined) throw new MarketDataError(this.key, `No price for ${ref.symbol}`);
    return p;
  }

  async getPrices(refs: SymbolRef[]) {
    const bySource = new Map(refs.map((r) => [toBinanceSymbol(r), r.symbol]));
    const url = `${BASE_URL}/ticker/price?symbols=${encodeURIComponent(JSON.stringify([...bySource.keys()]))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!res.ok) throw new MarketDataError(this.key, `HTTP ${res.status}`);
    const data = (await res.json()) as { symbol: string; price: string }[];
    const out = new Map<string, number>();
    for (const row of data) {
      const symbol = bySource.get(row.symbol);
      const price = Number(row.price);
      if (symbol && Number.isFinite(price) && price > 0) out.set(symbol, price);
    }
    return out;
  }
}
