import { NextResponse } from "next/server";
import { route, parseBody } from "@/lib/api";
import { backtestInputSchema, createBacktest, listBacktests } from "@/lib/services/backtests";

export const GET = route(async ({ user }) => ({ backtests: await listBacktests(user.id) }));

/** Queues a backtest; the worker runs it. Poll GET /api/backtests/:id for progress. */
export const POST = route(
  async ({ req, user }) =>
    NextResponse.json({ backtest: await createBacktest(user.id, await parseBody(req, backtestInputSchema)) }, { status: 201 }),
  { rateLimit: [20, 60_000], bucket: "backtests" },
);
