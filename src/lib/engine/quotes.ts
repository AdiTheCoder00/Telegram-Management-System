import { db } from "@/lib/db";

export const GLOBAL_SCOPE = "global";

export type QuoteWriteResult = "new" | "duplicate" | "stale";

/**
 * Atomically upserts the latest quote. Out-of-order (older) ticks are rejected as "stale" and
 * identical re-deliveries (same timestamp + price) as "duplicate" — neither reaches the engine.
 * Parameterised SQL via Prisma's tagged template (no injection possible).
 */
export async function recordQuote(provider: string, scope: string, symbol: string, price: number, time: Date): Promise<QuoteWriteResult> {
  // Use the app clock as an explicit parameter (never NOW()), so the value does not depend on the DB session time zone.
  const receivedAt = new Date();
  const rows = await db.$queryRaw<{ inserted: boolean }[]>`
    INSERT INTO "Quote" ("provider", "scope", "symbol", "price", "sourceTime", "updatedAt")
    VALUES (${provider}, ${scope}, ${symbol}, ${price}, ${time}, ${receivedAt})
    ON CONFLICT ("provider", "scope", "symbol") DO UPDATE
      SET "price" = EXCLUDED."price", "sourceTime" = EXCLUDED."sourceTime", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "Quote"."sourceTime" < EXCLUDED."sourceTime"
         OR ("Quote"."sourceTime" = EXCLUDED."sourceTime" AND "Quote"."price" <> EXCLUDED."price")
    RETURNING true AS inserted`;
  if (rows.length) return "new";
  const existing = await db.quote.findUnique({ where: { provider_scope_symbol: { provider, scope, symbol } } });
  return existing && existing.sourceTime.getTime() > time.getTime() ? "stale" : "duplicate";
}

/** Latest quote visible to a user for a provider/symbol (global feed or their own webhook feed). */
export async function latestQuote(provider: string, symbol: string, userId?: string) {
  return db.quote.findFirst({
    where: { provider, symbol, scope: { in: userId ? [GLOBAL_SCOPE, userId] : [GLOBAL_SCOPE] } },
    orderBy: { updatedAt: "desc" },
  });
}

/** Map of "provider:symbol" → latest price, for tables. */
export async function latestQuotesFor(pairs: { provider: string; symbol: string }[], userId: string) {
  if (!pairs.length) return new Map<string, { price: number; updatedAt: Date }>();
  const quotes = await db.quote.findMany({
    where: {
      scope: { in: [GLOBAL_SCOPE, userId] },
      OR: pairs.map((p) => ({ provider: p.provider, symbol: p.symbol })),
    },
    orderBy: { updatedAt: "asc" },
  });
  const map = new Map<string, { price: number; updatedAt: Date }>();
  for (const q of quotes) map.set(`${q.provider}:${q.symbol}`, { price: q.price, updatedAt: q.updatedAt });
  return map;
}
