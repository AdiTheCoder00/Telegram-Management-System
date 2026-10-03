import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { duplicateAlert } from "@/lib/services/alerts";

export const POST = route<{ id: string }>(async ({ user, params }) =>
  NextResponse.json({ alert: await duplicateAlert(user.id, params.id) }, { status: 201 }),
);
