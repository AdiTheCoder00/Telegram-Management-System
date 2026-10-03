import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { AppError, tooManyRequests } from "@/lib/errors";
import { fakeVerify, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const POST = route(
  async ({ req, ip }) => {
    const input = await parseBody(req, loginSchema);
    // Per-account brute-force protection (in addition to the per-IP limit below).
    const rl = await rateLimit(`login:${input.email}`, 10, 15 * 60_000);
    if (!rl.ok) throw tooManyRequests(rl.retryAfterSec);

    const user = await db.user.findUnique({ where: { email: input.email } });
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : await fakeVerify(input.password);
    if (!user || !ok) {
      logger.warn("Failed login", { email: input.email, ip });
      throw new AppError(401, "Incorrect email or password.", "invalid_credentials");
    }
    await createSession(user.id, { userAgent: req.headers.get("user-agent"), ip });
    return { user: { id: user.id, email: user.email, name: user.name } };
  },
  { auth: false, rateLimit: [20, 15 * 60_000], bucket: "login" },
);
