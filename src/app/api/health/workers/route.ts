import { NextResponse } from "next/server";
import { checkWorkers } from "@/lib/health";

export const dynamic = "force-dynamic";

// 200 when the component is usable (RUNNING), 503 otherwise.
const OK = new Set(["RUNNING"]);

export async function GET() {
  const health = await checkWorkers();
  return NextResponse.json(health, { status: OK.has(health.status) ? 200 : 503, headers: { "cache-control": "no-store" } });
}
