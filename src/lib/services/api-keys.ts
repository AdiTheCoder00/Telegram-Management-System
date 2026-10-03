import { db } from "@/lib/db";
import { randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { notFound } from "@/lib/errors";
import { GLOBAL_SCOPE } from "@/lib/engine/quotes";

const PREFIX = "tam_";

/** Creates a webhook API key. The raw key is returned once and only its hash is stored. */
export async function createApiKey(userId: string, name: string) {
  const raw = `${PREFIX}${randomToken(24)}`;
  const key = await db.apiKey.create({
    data: { userId, name, prefix: raw.slice(0, 10), keyHash: sha256(raw) },
  });
  return { id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt, key: raw };
}

export async function listApiKeys(userId: string) {
  return db.apiKey.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeApiKey(userId: string, id: string) {
  const key = await db.apiKey.findFirst({ where: { id, userId, revokedAt: null } });
  if (!key) throw notFound("API key");
  await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

/**
 * Resolves webhook credentials to a price scope:
 *  - the operator's WEBHOOK_SECRET → "global" (feeds every user's webhook alerts for the symbol)
 *  - a user's API key → that userId (feeds only that user's alerts)
 * Accepts `Authorization: Bearer <key>`, `X-API-Key: <key>` or `X-Webhook-Secret: <secret>`.
 * (TradingView cannot set headers, so `?key=<key>` is also accepted for user keys.)
 */
export async function resolveWebhookScope(headers: Headers, url: URL): Promise<string | null> {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const candidate = (bearer ?? headers.get("x-api-key") ?? headers.get("x-webhook-secret") ?? url.searchParams.get("key"))?.trim();
  if (!candidate || candidate.length > 200) return null;

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && secret.length >= 16 && safeEqual(candidate, secret)) return GLOBAL_SCOPE;

  if (candidate.startsWith(PREFIX)) {
    const key = await db.apiKey.findUnique({ where: { keyHash: sha256(candidate) } });
    if (key && !key.revokedAt) {
      await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
      return key.userId;
    }
  }
  return null;
}
