import type { MarketDataProvider, SymbolRef } from "../types";

/**
 * Mock provider for local development and demos — no credentials required.
 * Produces a slow random walk around realistic base prices. Replace with a real provider in production
 * by setting DEFAULT_MARKET_DATA_PROVIDER or choosing a data source per alert.
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

const state = new Map<string, { price: number; at: number }>();

function seedFor(symbol: string) {
  if (BASE[symbol]) return BASE[symbol];
  // Deterministic pseudo-price for unknown symbols so custom symbols still work in dev.
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 10 + (h % 9_000);
}

export function simulatedPrice(symbol: string, now = Date.now()): number {
  const s = state.get(symbol);
  if (!s) {
    const p = seedFor(symbol);
    state.set(symbol, { price: p, at: now });
    return p;
  }
  const elapsedSec = Math.max(0, (now - s.at) / 1000);
  if (elapsedSec < 0.5) return s.price;
  // ~0.02% volatility per sqrt(second), mean-reverting toward the base price
  const vol = 0.0002 * Math.sqrt(Math.min(elapsedSec, 300));
  const base = seedFor(symbol);
  const drift = ((base - s.price) / base) * 0.05;
  const next = s.price * (1 + drift + vol * (Math.random() * 2 - 1));
  const decimals = base < 10 ? 5 : 2;
  const rounded = Number(next.toFixed(decimals));
  state.set(symbol, { price: rounded, at: now });
  return rounded;
}

export class SimulatedProvider implements MarketDataProvider {
  readonly key = "simulated";
  readonly label = "Simulated (demo)";
  readonly description = "Random-walk prices for testing without API credentials.";

  isConfigured() {
    return true;
  }

  async getPrice({ symbol }: SymbolRef) {
    return simulatedPrice(symbol);
  }

  async getPrices(symbols: SymbolRef[]) {
    return new Map(symbols.map(({ symbol }) => [symbol, simulatedPrice(symbol)]));
  }
}
