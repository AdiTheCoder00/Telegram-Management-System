import { cookies } from "next/headers";
import { cache } from "react";
import { db } from "@/lib/db";
import { hmac, randomToken } from "@/lib/crypto";
import { authSecret } from "@/lib/env";

export const SESSION_COOKIE = "tam_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

/** Keyed hash (HMAC with NEXTAUTH_SECRET) of a session token — the raw token is never stored. */
export const hashSessionToken = (token: string) => hmac(authSecret(), token);

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
}

/**
 * Database-backed sessions. The cookie holds a random 256-bit token; only its HMAC is stored,
 * so a database leak does not leak usable sessions. Cookies are HttpOnly, SameSite=Lax and Secure in production.
 */
export async function createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null } = {}) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 255),
      ip: meta.ip?.slice(0, 64),
    },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function validateSessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { select: { id: true, email: true, name: true, timezone: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  // Sliding expiration
  if (session.expiresAt.getTime() - Date.now() < RENEW_THRESHOLD_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
      .catch(() => undefined);
  }
  return session.user;
}

/** Returns the signed-in user for the current request (memoised per request). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  return validateSessionToken(jar.get(SESSION_COOKIE)?.value);
});

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  jar.delete(SESSION_COOKIE);
}
