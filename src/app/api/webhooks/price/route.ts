import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, parseBody, clientIp } from "@/lib/api";
import { AppError, tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { priceWebhookSchema } from "@/lib/validation";
import { resolveWebhookScope } from "@/lib/services/api-keys";
import { ingestTicks } from "@/lib/services/prices";
import { deliverAfterResponse } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhooks/price — push prices into the alert engine (TradingView, custom feeds).
 * Auth: Authorization: Bearer <key> | X-API-Key | X-Webhook-Secret | ?key=  (see README)
 * Body: { symbol, price, timestamp?, id? }  or  { prices: [ ... ] }
 * Idempotent: duplicate `id`s and identical (timestamp, price) re-deliveries are ignored.
 * No cookies are used, so CSRF does not apply; authentication is by secret only.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const ipLimit = await rateLimit(`webhook-ip:${ip}`, 600, 60_000);
    if (!ipLimit.ok) throw tooManyRequests(ipLimit.retryAfterSec);

    const scope = await resolveWebhookScope(req.headers, req.nextUrl);
    if (!scope) {
      logger.warn("Webhook rejected: invalid credentials", { ip });
      throw new AppError(401, "Invalid or missing webhook API key.", "unauthorized");
    }
    const rl = await rateLimit(`webhook:${scope}`, 1200, 60_000);
    if (!rl.ok) throw tooManyRequests(rl.retryAfterSec);

    const body = await parseBody(req, priceWebhookSchema);
    const items = "prices" in body ? body.prices : [body];

    const fresh: { symbol: string; price: number; time: Date }[] = [];
    let duplicates = 0;
    for (const item of items) {
      if (item.id) {
        const r = await db.webhookReceipt.createMany({ data: [{ scope, key: item.id }], skipDuplicates: true });
        if (r.count === 0) {
          duplicates++;
          continue;
        }
      }
      fresh.push({ symbol: item.symbol, price: item.price, time: item.timestamp ?? new Date() });
    }

    const out = await ingestTicks("webhook", scope, fresh);
    if (!out.queued) deliverAfterResponse(out.deliveryIds);

    return NextResponse.json(
      { ok: true, accepted: fresh.length, duplicates, results: out.results, triggered: out.deliveryIds.length },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err, req);
  }
}
