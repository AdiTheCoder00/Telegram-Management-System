import { db } from "@/lib/db";
import { MarketDataError, type MarketDataProvider, type SymbolRef } from "../types";

/**
 * Push-only provider: prices arrive through POST /api/webhooks/price (TradingView alerts, custom feeds …).
 * getPrice() returns the last pushed value so the UI can display it.
 */
export class WebhookProvider implements MarketDataProvider {
  readonly key = "webhook";
  readonly label = "Webhook / TradingView";
  readonly description = "Prices pushed to /api/webhooks/price (e.g. TradingView alerts).";
  /** Price-only source: candles for condition alerts are built from its ticks (volume = tick count). */
  readonly capabilities = { realtime: "push" as const, candleTimeframes: [], historyDays: 0, volume: "TICK" as const };
  readonly pushOnly = true;

  isConfigured() {
    return true;
  }

  async getPrice({ symbol }: SymbolRef) {
    const q = await db.quote.findFirst({ where: { provider: this.key, symbol }, orderBy: { updatedAt: "desc" } });
    if (!q) throw new MarketDataError(this.key, `No webhook price received yet for ${symbol}`);
    return q.price;
  }
}
