import { NextResponse } from "next/server";
import { checkRedis } from "@/lib/health";

export const dynamic = "force-dynamic";

// 200 when the component is usable (CONNECTED,NOT_CONFIGURED), 503 otherwise.
const OK = new Set(["CONNECTED", "NOT_CONFIGURED"]);

export async function GET() {
  const health = await checkRedis();
  return NextResponse.json(health, { status: OK.has(health.status) ? 200 : 503, headers: { "cache-control": "no-store" } });
}
