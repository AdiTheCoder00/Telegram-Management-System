import { NextResponse } from "next/server";
import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { createGroup, listGroups } from "@/lib/services/alert-bulk";

export const GET = route(async ({ user }) => ({ groups: await listGroups(user.id) }));

export const POST = route(async ({ req, user }) => {
  const { name } = await parseBody(req, z.object({ name: z.string().trim().min(1).max(60) }));
  return NextResponse.json({ group: await createGroup(user.id, name) }, { status: 201 });
});
