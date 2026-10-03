import { NextResponse } from "next/server";
import { route, parseBody } from "@/lib/api";
import { AppError, tooManyRequests } from "@/lib/errors";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validation";
import { authenticate } from "@/lib/services/auth";
import { logger } from "@/lib/logger";

export const POST = route(
  async ({ req, ip }) => {
    const input = await parseBody(req, loginSchema);
    // Per-account brute-force protection (in addition to the per-IP limit below).
    const rl = await rateLimit(`login:${input.email}`, 10, 15 * 60_000);
    if (!rl.ok) throw tooManyRequests(rl.retryAfterSec);

    const user = await authenticate(input.email, input.password);
    if (!user) {
      logger.warn("Failed login", { email: input.email, ip });
      throw new AppError(401, "Incorrect email or password.", "invalid_credentials");
    }
    const token = await createSession(user.id, { userAgent: req.headers.get("user-agent"), ip });
    const res = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
    setSessionCookie(res, token);
    return res;
  },
  { auth: false, rateLimit: [20, 15 * 60_000], bucket: "login" },
);
