import type { Candle, VolumeType } from "@/lib/market/candles";
import type { Timeframe } from "@/lib/market/timeframes";

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

/**
 * What a provider can do (M7 capability matrix). Alerts are validated against this before activation —
 * nothing assumes every provider supports every feature.
 */
export interface ProviderCapabilities {
  /** How live data arrives. "polling" = REST snapshots; "push" = webhook only. */
  realtime: "polling" | "push" | "websocket";
  /** Timeframes the provider returns natively as OHLC candles (others may be aggregated from these). */
  candleTimeframes: Timeframe[];
  /** How far back historical candles go (days), for backtests. 0 = no history API. */
  historyDays: number;
  /** Volume semantics of the provider's candles. */
  volume: VolumeType;
  /** Live data is synthetic (mock). Never reported as live market data. */
  synthetic?: boolean;
}

export interface CandleQuery {
  /** Inclusive start (epoch ms). */
  from?: number;
  /** Exclusive end (epoch ms). Defaults to now. */
  to?: number;
  /** Max candles (most recent first when only `limit` is given). */
  limit?: number;
}

export interface MarketDataProvider {
  /** Stable key stored on alerts (Alert.dataProvider). */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Push-only providers (webhooks) are never polled; prices arrive via POST /api/webhooks/price. */
  readonly pushOnly?: boolean;
  readonly capabilities: ProviderCapabilities;

  /**
   * Historical/recent OHLC candles for a native timeframe, as canonical candles (UTC, aligned). The caller
   * normalises (validation, lifecycle) — providers must not invent missing candles.
   */
  getCandles?(symbol: SymbolRef, timeframe: Timeframe, query: CandleQuery): Promise<Candle[]>;

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
