import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getProvider } from "@/lib/market-data/registry";
import { MarketDataError, type SymbolRef } from "@/lib/market-data/types";
import { GLOBAL_SCOPE, latestQuote, recordQuote } from "@/lib/engine/quotes";
import { allowProviderRequest } from "@/lib/market/service";
import { expireDueAlerts, processPriceTick, releaseFinishedCooldowns } from "@/lib/engine/engine";
import { enqueueDeliveries } from "@/lib/queue";
import { evaluateConditionAlerts } from "@/lib/engine/condition-engine";

async function symbolRefs(symbols: string[]): Promise<SymbolRef[]> {
  const instruments = await db.instrument.findMany({
    where: { symbol: { in: symbols } },
    select: { symbol: true, providerSymbol: true, provider: true },
  });
  const map = new Map(instruments.map((i) => [i.symbol, i]));
  return symbols.map((symbol) => ({ symbol, providerSymbol: map.get(symbol)?.providerSymbol ?? null }));
}

/**
 * Current price for display. Uses a recent cached quote when available; otherwise fetches live from
 * the provider. Returns price null (with a friendly error) when unavailable.
 */
export async function getDisplayPrice(provider: string, symbol: string, userId: string) {
  const p = getProvider(provider);
  if (!p) return { price: null, updatedAt: null, error: "Unknown data provider." };
  const cached = await latestQuote(provider, symbol, userId);
  const freshMs = Number(process.env.PRICE_POLL_INTERVAL_MS ?? 5000) * 2;
  if (cached && (p.pushOnly || Date.now() - cached.updatedAt.getTime() < freshMs))
    return { price: cached.price, updatedAt: cached.updatedAt, error: null };
  if (p.pushOnly) return { price: null, updatedAt: null, error: "No price received yet. Send one to the webhook endpoint." };
  if (!p.isConfigured())
    return { price: cached?.price ?? null, updatedAt: cached?.updatedAt ?? null, error: `${p.label} is not configured.` };
  // The display path shares the per-provider request budget with the candle service: without it, a form polling
  // every few seconds would exhaust a rate-limited provider (e.g. Twelve Data's 8/min free tier) on its own.
  if (!(await allowProviderRequest(p))) {
    return {
      price: cached?.price ?? null,
      updatedAt: cached?.updatedAt ?? null,
      error: cached ? null : "Market data is temporarily unavailable for this symbol.",
    };
  }
  try {
    const [ref] = await symbolRefs([symbol]);
    const price = await p.getPrice(ref);
    // Best-effort cache write: the next polls are served from the quote cache even if this write fails.
    await recordQuote(provider, GLOBAL_SCOPE, symbol, price, new Date()).catch(() => undefined);
    return { price, updatedAt: new Date(), error: null };
  } catch (err) {
    logger.warn("Live price fetch failed", { provider, symbol, err: String(err) });
    return {
      price: cached?.price ?? null,
      updatedAt: cached?.updatedAt ?? null,
      error: "Market data is temporarily unavailable for this symbol.",
    };
  }
}

/** Feeds ticks through the engine and enqueues any resulting deliveries. */
export async function ingestTicks(
  provider: string,
  scope: string,
  ticks: { symbol: string; price: number; time?: Date; fromBar?: boolean }[],
) {
  const results = [];
  const deliveryIds: string[] = [];
  for (const t of ticks) {
    const r = await processPriceTick({ provider, scope, symbol: t.symbol, price: t.price, time: t.time, fromBar: t.fromBar });
    results.push({ symbol: t.symbol, quote: r.quote, evaluated: r.evaluated, triggered: r.triggered.length });
    for (const tr of r.triggered) if (tr.deliveryId) deliveryIds.push(tr.deliveryId);
  }
  const queued = await enqueueDeliveries(deliveryIds);
  return { results, deliveryIds, queued };
}

/**
 * One polling cycle: for every (provider, symbol) watched by an ACTIVE alert, fetch prices
 * (batched per provider) and push them through the engine. A failing provider is logged and skipped —
 * alerts simply wait for the next successful update (market data temporarily unavailable).
 */
export async function pollOnce() {
  await expireDueAlerts();
  await releaseFinishedCooldowns();
  const live = { in: ["ACTIVE", "COOLDOWN"] as ("ACTIVE" | "COOLDOWN")[] };
  // Price polling feeds PRICE alerts, plus CONDITIONS alerts whose provider has no native candles (their
  // candles are built from these ticks). Candle providers serve CONDITIONS alerts via the market-data service.
  const pairs = (await db.alert.groupBy({ by: ["dataProvider", "symbol", "kind"], where: { status: live } })).filter(
    (p) => p.kind === "PRICE" || (getProvider(p.dataProvider)?.capabilities.candleTimeframes.length ?? 0) === 0,
  );
  const byProvider = new Map<string, string[]>();
  for (const p of pairs) {
    if (byProvider.get(p.dataProvider)?.includes(p.symbol)) continue;
    const list = byProvider.get(p.dataProvider) ?? [];
    list.push(p.symbol);
    byProvider.set(p.dataProvider, list);
  }

  const summary: Record<string, { symbols: number; ok: number; error?: string }> = {};
  const deliveryIds: string[] = [];
  await Promise.all(
    [...byProvider].map(async ([key, symbols]) => {
      const provider = getProvider(key);
      if (!provider || provider.pushOnly) return;
      summary[key] = { symbols: symbols.length, ok: 0 };
      if (!provider.isConfigured()) {
        summary[key].error = "not configured";
        return;
      }
      try {
        const refs = await symbolRefs(symbols);
        let prices: Map<string, number>;
        if (provider.getPrices) prices = await provider.getPrices(refs);
        else {
          prices = new Map();
          for (const r of refs) {
            try {
              prices.set(r.symbol, await provider.getPrice(r));
            } catch (err) {
              logger.warn("Price fetch failed", { provider: key, symbol: r.symbol, err: String(err) });
            }
          }
        }
        const now = new Date();
        const { deliveryIds: ids } = await ingestTicks(
          key,
          GLOBAL_SCOPE,
          [...prices].map(([symbol, price]) => ({ symbol, price, time: now })),
        );
        deliveryIds.push(...ids);
        summary[key].ok = prices.size;
      } catch (err) {
        summary[key].error = err instanceof MarketDataError ? err.message : "fetch failed";
        logger.warn("Market data temporarily unavailable", { provider: key, err: String(err) });
      }
    }),
  );
  // Condition-tree alerts (candles, indicators, MTF) — after ticks so tick candles include this cycle.
  const conditions = await evaluateConditionAlerts();
  for (const t of conditions.triggered) if (t.deliveryId) deliveryIds.push(t.deliveryId);
  if (conditions.triggered.length) await enqueueDeliveries(conditions.triggered.flatMap((t) => (t.deliveryId ? [t.deliveryId] : [])));
  return {
    summary,
    deliveryIds,
    conditions: { evaluated: conditions.evaluated, triggered: conditions.triggered.length, waiting: conditions.waiting },
  };
}
