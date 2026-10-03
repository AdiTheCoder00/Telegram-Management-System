import { NextResponse } from "next/server";
import { route, parseBody } from "@/lib/api";
import { createBotSchema } from "@/lib/validation";
import { createBot, listBots } from "@/lib/services/bots";

export const GET = route(async ({ user }) => ({ bots: await listBots(user.id) }));

export const POST = route(
  async ({ req, user }) => {
    const input = await parseBody(req, createBotSchema);
    return NextResponse.json({ bot: await createBot(user.id, input) }, { status: 201 });
  },
  { rateLimit: [20, 60_000], bucket: "bots-create" },
);
