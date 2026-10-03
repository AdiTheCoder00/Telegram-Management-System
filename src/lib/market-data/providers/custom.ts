import { MarketDataError, type MarketDataProvider, type SymbolRef } from "../types";

/**
 * Generic REST provider for any JSON price API, configured entirely via environment variables:
 *   CUSTOM_PRICE_URL=https://example.com/quote?symbol={symbol}
 *   CUSTOM_PRICE_JSON_PATH=data.price
 *   CUSTOM_PRICE_API_KEY_HEADER=X-API-Key   (value taken from MARKET_DATA_API_KEY)
 */
function readPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

export class CustomRestProvider implements MarketDataProvider {
  readonly key = "custom";
  readonly label = "Custom REST API";
  readonly description = "Your own price endpoint (configure CUSTOM_PRICE_URL).";
  /** Price-only source: candles for condition alerts are built from its ticks (volume = tick count). */
  readonly capabilities = { realtime: "polling" as const, candleTimeframes: [], historyDays: 0, volume: "TICK" as const };

  isConfigured() {
    return !!process.env.CUSTOM_PRICE_URL;
  }

  async getPrice({ symbol, providerSymbol }: SymbolRef) {
    const template = process.env.CUSTOM_PRICE_URL;
    if (!template) throw new MarketDataError(this.key, "CUSTOM_PRICE_URL is not configured");
    const url = template.replace("{symbol}", encodeURIComponent(providerSymbol ?? symbol));
    const headers: Record<string, string> = { accept: "application/json" };
    const header = process.env.CUSTOM_PRICE_API_KEY_HEADER;
    if (header && process.env.MARKET_DATA_API_KEY) headers[header] = process.env.MARKET_DATA_API_KEY;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!res.ok) throw new MarketDataError(this.key, `HTTP ${res.status}`);
    const price = Number(readPath(await res.json(), process.env.CUSTOM_PRICE_JSON_PATH || "price"));
    if (!Number.isFinite(price) || price <= 0) throw new MarketDataError(this.key, `Invalid price for ${symbol}`);
    return price;
  }
}
