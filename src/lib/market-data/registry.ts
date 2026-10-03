import type { MarketDataProvider } from "./types";
import { SimulatedProvider } from "./providers/simulated";
import { BinanceProvider } from "./providers/binance";
import { TwelveDataProvider } from "./providers/twelvedata";
import { CustomRestProvider } from "./providers/custom";
import { WebhookProvider } from "./providers/webhook";

/**
 * Provider registry. To add a provider (e.g. Polygon, OANDA, a WebSocket feed):
 *   1. implement MarketDataProvider in ./providers/<name>.ts (declare its capabilities honestly)
 *   2. add an instance below
 * Nothing in the condition engine, alert engine, simulator or backtester changes: they consume canonical
 * candles from the market-data service only.
 */
const providers: MarketDataProvider[] = [
  new TwelveDataProvider(),
  new SimulatedProvider("mock"),
  new BinanceProvider(),
  new CustomRestProvider(),
  new WebhookProvider(),
];
/** Legacy key used by alerts created before the mock was renamed; same deterministic generator, not listed. */
const aliases: MarketDataProvider[] = [new SimulatedProvider("simulated")];

const byKey = new Map([...providers, ...aliases].map((p) => [p.key, p]));

export function getProvider(key: string): MarketDataProvider | undefined {
  return byKey.get(key);
}

export function listProviders() {
  return providers.map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    pushOnly: !!p.pushOnly,
    configured: p.isConfigured(),
    capabilities: p.capabilities,
  }));
}

/** MARKET_DATA_PROVIDER (spec name) or DEFAULT_MARKET_DATA_PROVIDER; falls back to the mock. */
export function defaultProviderKey(): string {
  const key = process.env.MARKET_DATA_PROVIDER || process.env.DEFAULT_MARKET_DATA_PROVIDER || "mock";
  return byKey.has(key) ? key : "mock";
}

export function isValidProvider(key: string) {
  return byKey.has(key);
}

export function isSynthetic(key: string) {
  return !!byKey.get(key)?.capabilities.synthetic;
}
