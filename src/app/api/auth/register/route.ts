import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { registerSchema } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const POST = route(
  async ({ req, ip }) => {
    const input = await parseBody(req, registerSchema);
    const existing = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) throw new AppError(409, "An account with this email already exists. Try signing in.", "email_taken");
    const user = await db.user.create({
      data: { email: input.email, name: input.name, passwordHash: await hashPassword(input.password) },
      select: { id: true, email: true, name: true },
    });
    await createSession(user.id, { userAgent: req.headers.get("user-agent"), ip });
    logger.info("User registered", { userId: user.id });
    return { user };
  },
  { auth: false, rateLimit: [5, 60 * 60_000], bucket: "register" },
);
