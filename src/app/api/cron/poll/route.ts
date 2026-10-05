import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { safeEqual } from "@/lib/crypto";
import { pollOnce } from "@/lib/services/prices";
import { sweepDueDeliveries } from "@/lib/notifications/delivery";
import { db } from "@/lib/db";
import { runNextBacktest } from "@/lib/services/backtests";
import { pruneCandles } from "@/lib/market/service";

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
    // No worker here: run at most one queued backtest per invocation, inside the function time limit. A run that
    // outlives the invocation is marked failed by the next cycle (RUNNING for longer than maxDuration).
    await db.backtest.updateMany({
      where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - (maxDuration + 15) * 1000) } },
      data: {
        status: "FAILED",
        error: "Interrupted: exceeded the serverless time limit. Use a shorter range or run the worker.",
        finishedAt: new Date(),
      },
    });
    const backtest = await runNextBacktest();
    if (new Date().getUTCMinutes() === 0) await pruneCandles().catch(() => undefined);
    return NextResponse.json({ ok: true, poll: poll.summary, deliveriesProcessed: sent, backtestRan: backtest });
  } catch (err) {
    return errorResponse(err, req);
  }
}
