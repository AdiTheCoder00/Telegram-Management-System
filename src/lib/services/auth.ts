import { db } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { fakeVerify, hashPassword, verifyPassword } from "@/lib/auth/password";
import { LOCAL_SESSION_ID } from "@/lib/auth/constants";

/**
 * Personal installation: registration is open only until the owner account exists (first-run setup).
 * Set ALLOW_REGISTRATION=true to permit additional accounts (e.g. a second personal login).
 */
export async function registrationOpen(): Promise<boolean> {
  if (process.env.ALLOW_REGISTRATION === "true") return true;
  return (await db.user.count()) === 0;
}

const REGISTRATION_LOCK = 724_310_001; // arbitrary constant for pg_advisory_xact_lock

export async function registerUser(input: { name: string; email: string; password: string; timezone?: string }) {
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    // Serialise sign-ups so two simultaneous first-run registrations cannot both become "the owner".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REGISTRATION_LOCK})`;
    const users = await tx.user.count();
    if (users > 0 && process.env.ALLOW_REGISTRATION !== "true") {
      throw new AppError(
        403,
        "Registration is closed. This installation already has an owner account — sign in instead.",
        "registration_closed",
      );
    }
    if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
      throw new AppError(409, "An account with this email already exists. Try signing in.", "email_taken");
    }
    return tx.user.create({
      data: { email: input.email, name: input.name, passwordHash, timezone: input.timezone ?? "UTC" },
      select: { id: true, email: true, name: true },
    });
  });
}

/** Returns the user when the credentials are valid; constant-time-ish for unknown emails. */
export async function authenticate(email: string, password: string) {
  const user = await db.user.findUnique({ where: { email } });
  const ok = user ? await verifyPassword(password, user.passwordHash) : await fakeVerify(password);
  return user && ok ? user : null;
}

/** Changes the password and signs out every other session (the current one stays signed in). */
export async function changePassword(userId: string, currentSessionId: string, current: string | undefined, next: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  // Local-mode access (this computer, no sign-in) may set a password without knowing the current one.
  const localAccess = currentSessionId === LOCAL_SESSION_ID;
  if (!localAccess && !current) {
    throw new AppError(400, "Enter your current password.", "invalid_password", {
      fieldErrors: { currentPassword: "Enter your current password." },
    });
  }
  if (!localAccess && !(await verifyPassword(current!, user.passwordHash))) {
    throw new AppError(400, "Current password is incorrect.", "invalid_password", {
      fieldErrors: { currentPassword: "Incorrect password." },
    });
  }
  if (current === next) {
    throw new AppError(400, "Choose a password different from the current one.", "same_password", {
      fieldErrors: { newPassword: "Must differ from the current password." },
    });
  }
  const passwordHash = await hashPassword(next);
  const [, revoked] = await db.$transaction([
    db.user.update({ where: { id: userId }, data: { passwordHash } }),
    db.session.deleteMany({ where: { userId, id: { not: currentSessionId } } }),
  ]);
  logger.info("Password changed", { userId, revokedSessions: revoked.count });
  return { revokedSessions: revoked.count };
}

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await db.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true, ip: true },
  });
  return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
}

export async function revokeSession(userId: string, sessionId: string) {
  const { count } = await db.session.deleteMany({ where: { id: sessionId, userId } });
  if (!count) throw notFound("Session");
}

export async function revokeOtherSessions(userId: string, currentSessionId: string) {
  const { count } = await db.session.deleteMany({ where: { userId, id: { not: currentSessionId } } });
  return { revoked: count };
}

/** Removes expired sessions (run hourly by the worker). */
export async function purgeExpiredSessions() {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return count;
}
