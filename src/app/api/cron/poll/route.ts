import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { safeEqual } from "@/lib/crypto";
import { pollOnce } from "@/lib/services/prices";
import { sweepDueDeliveries } from "@/lib/notifications/delivery";

export const maxDuration = 60;

/**
 * Serverless fallback for environments without a long-running worker (e.g. Vercel Cron, 1/min).
 * Runs one poll cycle and drains the delivery outbox. Auth: Authorization: Bearer <CRON_SECRET>.
 */
export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!secret || !given || !safeEqual(given, secret)) throw new AppError(401, "Unauthorized", "unauthorized");
    const poll = await pollOnce();
    const sent = await sweepDueDeliveries(100);
    return NextResponse.json({ ok: true, poll: poll.summary, deliveriesProcessed: sent });
  } catch (err) {
    return errorResponse(err, req);
  }
}
