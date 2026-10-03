import { NextResponse } from "next/server";
import { route, parseBody } from "@/lib/api";
import { apiKeyCreateSchema } from "@/lib/validation";
import { createApiKey, listApiKeys } from "@/lib/services/api-keys";

export const GET = route(async ({ user }) => ({ keys: await listApiKeys(user.id) }));

export const POST = route(
  async ({ req, user }) => {
    const { name } = await parseBody(req, apiKeyCreateSchema);
    return NextResponse.json({ key: await createApiKey(user.id, name) }, { status: 201 });
  },
  { rateLimit: [10, 60_000], bucket: "api-keys" },
);
