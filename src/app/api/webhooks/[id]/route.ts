import type { NextRequest } from "next/server";
import { handleWebhook } from "@/lib/webhook-ingest";

/** POST /api/webhooks/<webhookId> — generic JSON webhook; secret in X-Webhook-Secret or Authorization: Bearer. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return handleWebhook(req, (req.headers.get("x-webhook-secret") ?? bearer ?? null)?.trim() ?? null, id);
}
