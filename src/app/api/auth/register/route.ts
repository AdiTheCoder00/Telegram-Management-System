import { NextResponse } from "next/server";
import { route, parseBody } from "@/lib/api";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { registerSchema } from "@/lib/validation";
import { registerUser } from "@/lib/services/auth";
import { logger } from "@/lib/logger";

/** First-run setup: creates the owner account. Closed once an account exists (see ALLOW_REGISTRATION). */
export const POST = route(
  async ({ req, ip }) => {
    const input = await parseBody(req, registerSchema);
    const user = await registerUser(input);
    const token = await createSession(user.id, { userAgent: req.headers.get("user-agent"), ip });
    logger.info("User registered", { userId: user.id });
    const res = NextResponse.json({ user }, { status: 201 });
    setSessionCookie(res, token);
    return res;
  },
  { auth: false, rateLimit: [5, 60 * 60_000], bucket: "register" },
);
