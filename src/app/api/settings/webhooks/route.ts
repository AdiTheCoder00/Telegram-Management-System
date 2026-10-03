import { NextResponse } from "next/server";
import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { createWebhook, listWebhooks } from "@/lib/services/webhooks";

const createSchema = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(["TRADINGVIEW", "GENERIC"]).default("TRADINGVIEW") });

export const GET = route(async ({ user }) => ({ webhooks: await listWebhooks(user.id) }));

export const POST = route(
  async ({ req, user }) =>
    NextResponse.json({ webhook: await createWebhook(user.id, await parseBody(req, createSchema)) }, { status: 201 }),
  { rateLimit: [10, 60_000], bucket: "webhooks" },
);
