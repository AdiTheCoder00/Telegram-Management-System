import { NextResponse } from "next/server";
import { checkMarketData } from "@/lib/health";

export const dynamic = "force-dynamic";

// 200 when usable: CONNECTED, DEGRADED (partial or simulated data), NOT_CONFIGURED. STALE / ERROR → 503.
const OK = new Set(["CONNECTED", "DEGRADED", "NOT_CONFIGURED"]);

export async function GET() {
  const health = await checkMarketData();
  return NextResponse.json(health, { status: OK.has(health.status) ? 200 : 503, headers: { "cache-control": "no-store" } });
}
