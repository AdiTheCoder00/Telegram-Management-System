import type { NextRequest } from "next/server";
import { handleWebhook } from "@/lib/webhook-ingest";

/** POST /api/webhooks/tradingview/<secret> — TradingView alert webhook (the secret is the URL). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ secret: string }> }) {
  const { secret } = await ctx.params;
  return handleWebhook(req, secret);
}
