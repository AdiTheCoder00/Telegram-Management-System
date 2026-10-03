import type { MarketDataProvider } from "./types";
import { SimulatedProvider } from "./providers/simulated";
import { BinanceProvider } from "./providers/binance";
import { TwelveDataProvider } from "./providers/twelvedata";
import { CustomRestProvider } from "./providers/custom";
import { WebhookProvider } from "./providers/webhook";

/**
 * Provider registry. To add a provider (e.g. Polygon, OANDA, a WebSocket feed):
 *   1. implement MarketDataProvider in ./providers/<name>.ts
 *   2. add an instance below
 * Nothing else in the engine needs to change.
 */
const providers: MarketDataProvider[] = [
  new SimulatedProvider(),
  new BinanceProvider(),
  new TwelveDataProvider(),
  new CustomRestProvider(),
  new WebhookProvider(),
];

const byKey = new Map(providers.map((p) => [p.key, p]));

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
  }));
}

export function defaultProviderKey(): string {
  const key = process.env.DEFAULT_MARKET_DATA_PROVIDER || "simulated";
  return byKey.has(key) ? key : "simulated";
}

export function isValidProvider(key: string) {
  return byKey.has(key);
}
