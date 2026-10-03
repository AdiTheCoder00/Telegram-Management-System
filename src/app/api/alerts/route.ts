import { NextResponse } from "next/server";
import { route, parseBody, parseQuery } from "@/lib/api";
import { alertInputSchema, alertListQuerySchema } from "@/lib/validation";
import { createAlert, listAlerts } from "@/lib/services/alerts";

export const GET = route(async ({ req, user }) => {
  const q = parseQuery(req, alertListQuerySchema);
  return { alerts: await listAlerts(user.id, q) };
});

export const POST = route(async ({ req, user }) => {
  const input = await parseBody(req, alertInputSchema);
  return NextResponse.json({ alert: await createAlert(user.id, input) }, { status: 201 });
});
