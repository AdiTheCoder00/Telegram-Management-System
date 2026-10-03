import { NextResponse, type NextRequest } from "next/server";
import { clientIp, errorResponse } from "@/lib/api";
import { AppError, badRequest, tooManyRequests } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { deliverAfterResponse } from "@/lib/notifications/dispatch";
import { ingestWebhook, MAX_PAYLOAD_BYTES, resolveWebhookSecret } from "@/lib/services/webhooks";

/**
 * Shared handler for inbound webhook routes. Authentication is by secret only (no cookies → no CSRF).
 * Responses never echo the secret. Body size is capped before parsing.
 */
export async function handleWebhook(req: NextRequest, secret: string | null, expectId?: string) {
  try {
    const ip = clientIp(req);
    const ipLimit = await rateLimit(`webhook-ip:${ip}`, 600, 60_000);
    if (!ipLimit.ok) throw tooManyRequests(ipLimit.retryAfterSec);

    const webhook = await resolveWebhookSecret(secret, expectId);
    if (!webhook) {
      logger.warn("Webhook rejected: unknown, disabled or mismatched secret", { ip });
      throw new AppError(401, "Unknown or disabled webhook.", "unauthorized");
    }
    const rl = await rateLimit(`webhook-hook:${webhook.id}`, 600, 60_000);
    if (!rl.ok) throw tooManyRequests(rl.retryAfterSec);

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_PAYLOAD_BYTES) throw badRequest(`Payload too large (max ${MAX_PAYLOAD_BYTES / 1024} KB).`);
    const text = await req.text(); // TradingView sends JSON as text/plain
    const out = await ingestWebhook(webhook, text);
    if (!out.queued) deliverAfterResponse(out.deliveryIds);
    return NextResponse.json(
      { ok: true, accepted: out.accepted, bars: out.bars, duplicates: out.duplicates, rejected: out.rejected, triggered: out.triggered },
      { status: out.accepted || out.duplicates ? 202 : 400 },
    );
  } catch (err) {
    return errorResponse(err, req);
  }
}
