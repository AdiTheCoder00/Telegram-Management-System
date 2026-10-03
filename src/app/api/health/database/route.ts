import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/health";

export const dynamic = "force-dynamic";

// 200 when the component is usable (CONNECTED), 503 otherwise.
const OK = new Set(["CONNECTED"]);

export async function GET() {
  const health = await checkDatabase();
  return NextResponse.json(health, { status: OK.has(health.status) ? 200 : 503, headers: { "cache-control": "no-store" } });
}
