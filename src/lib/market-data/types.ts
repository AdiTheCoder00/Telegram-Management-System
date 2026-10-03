/**
 * Market-data provider abstraction. The alert engine only ever sees (provider, symbol, price, time) ticks,
 * so any source — REST polling, WebSocket streams, webhooks — can be plugged in by implementing this interface
 * and registering it in ./registry.ts.
 */
export interface PriceTick {
  symbol: string;
  price: number;
  time: Date;
}

export type PriceCallback = (tick: PriceTick) => void;

export interface SymbolRef {
  /** Canonical symbol used throughout the app, e.g. XAUUSD */
  symbol: string;
  /** Provider-specific symbol, e.g. XAU/USD or BTCUSDT (from the Instrument table, if configured) */
  providerSymbol?: string | null;
}

export interface MarketDataProvider {
  /** Stable key stored on alerts (Alert.dataProvider). */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Push-only providers (webhooks) are never polled; prices arrive via POST /api/webhooks/price. */
  readonly pushOnly?: boolean;

  /** Whether required configuration (API keys, URLs) is present. */
  isConfigured(): boolean;

  getPrice(symbol: SymbolRef): Promise<number>;

  /** Optional batched fetch; the poller prefers it when available. Missing symbols are simply omitted. */
  getPrices?(symbols: SymbolRef[]): Promise<Map<string, number>>;

  /**
   * Optional streaming subscription (WebSocket providers). Returns an unsubscribe function.
   * TODO(websocket): implement for Binance (wss://stream.binance.com:9443/ws/<symbol>@trade) and wire it into
   * the worker as a long-lived stream that feeds processPriceTick() instead of polling.
   */
  subscribe?(symbol: SymbolRef, callback: PriceCallback): () => void;
}

export class MarketDataError extends Error {
  constructor(
    public provider: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}
