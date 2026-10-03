import { NextResponse } from "next/server";
import { checkAll } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Aggregate health. 200 when the app can serve requests (database reachable), 503 otherwise.
 * `status` is OK | DEGRADED | DOWN; per-component detail is under `checks` and the /api/health/* routes.
 */
export async function GET() {
  const result = await checkAll();
  const summary = Object.fromEntries(Object.entries(result.checks).map(([k, v]) => [k, v.status]));
  return NextResponse.json(
    { ok: result.status !== "DOWN", status: result.status, checks: summary },
    { status: result.status === "DOWN" ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}
