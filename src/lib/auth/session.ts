import { cookies, headers } from "next/headers";
import type { NextResponse } from "next/server";
import { cache } from "react";
import { db } from "@/lib/db";
import { hmac, randomToken } from "@/lib/crypto";
import { authSecret } from "@/lib/env";
import { getLocalOwner, localAccessAllowed } from "@/lib/auth/local-mode";

export const SESSION_COOKIE = "tam_session";
/** Idle timeout: a session expires after 30 days without use (renewed on activity). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;
/** Activity timestamp is written at most this often (avoids a DB write on every request). */
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;
/**
 * The cookie outlives the DB session on purpose: the database expiry is the only authority, and it slides
 * on activity. (Browsers cap cookie lifetime at ~400 days.)
 */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** Keyed hash (HMAC with NEXTAUTH_SECRET) of a session token — the raw token is never stored. */
export const hashSessionToken = (token: string) => hmac(authSecret(), token);

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  sessionId: string;
}

/**
 * Database-backed sessions. The cookie holds a random 256-bit token; only its HMAC is stored,
 * so a database leak does not leak usable sessions. Cookies are HttpOnly, SameSite=Lax and Secure in production.
 */
export async function createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null } = {}) {
  const token = randomToken(32);
  const now = new Date();
  await db.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      lastSeenAt: now,
      userAgent: meta.userAgent?.slice(0, 255),
      ip: meta.ip?.slice(0, 64),
    },
  });
  return token;
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function validateSessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { select: { id: true, email: true, name: true, timezone: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  const renew = session.expiresAt.getTime() - now < RENEW_THRESHOLD_MS;
  const touch = now - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS;
  if (renew || touch) {
    await db.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now), ...(renew ? { expiresAt: new Date(now + SESSION_TTL_MS) } : {}) },
      })
      .catch(() => undefined);
  }
  return { ...session.user, sessionId: session.id };
}

/**
 * Returns the signed-in user for the current request (memoised per request). Server components only.
 * In local mode (see local-mode.ts) requests from this computer get the owner without signing in.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const user = await validateSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (user) return user;
  const h = await headers();
  return localAccessAllowed(h.get("host")) ? getLocalOwner() : null;
});

/** Same resolution for route handlers, from the request's cookie and Host header. */
export async function resolveRequestUser(token: string | undefined, host: string | null): Promise<SessionUser | null> {
  const user = await validateSessionToken(token);
  if (user) return user;
  return localAccessAllowed(host) ? getLocalOwner() : null;
}

export async function destroySessionByToken(token: string | undefined | null) {
  if (token) await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}
