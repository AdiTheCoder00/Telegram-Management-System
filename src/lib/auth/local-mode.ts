import { db } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { registerUser } from "@/lib/services/auth";

/**
 * Local mode: no sign-in on this computer.
 *
 * Active only when ALL of these hold:
 *  1. AUTH_MODE=local
 *  2. the server was started by scripts/run-local.mjs (LEVELS_LOOPBACK_ONLY=1), which binds 127.0.0.1 — other
 *     machines cannot connect at all. Headers alone can't prove locality: Host and X-Forwarded-For are
 *     forgeable by any client on the network (verified).
 *  3. the request's Host is localhost / 127.0.0.1 / [::1] — blocks DNS-rebinding pages from a browser.
 * Anything else (Docker, plain `next start`, a deployed server) keeps requiring a password.
 */
import { LOCAL_SESSION_ID } from "@/lib/auth/constants";

export { LOCAL_SESSION_ID };

export function localModeConfigured() {
  return process.env.AUTH_MODE === "local";
}

export function localModeActive() {
  return localModeConfigured() && process.env.LEVELS_LOOPBACK_ONLY === "1";
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export function isLoopbackHost(host: string | null | undefined) {
  return !!host && LOOPBACK_HOST.test(host);
}

export function localAccessAllowed(host: string | null | undefined) {
  return localModeActive() && isLoopbackHost(host);
}

const ownerSelect = { id: true, email: true, name: true, timezone: true } as const;

/** The owner account used for local access; created on first run if the database has no user yet. */
export async function getLocalOwner() {
  let owner = await db.user.findFirst({ orderBy: { createdAt: "asc" }, select: ownerSelect });
  if (!owner) {
    try {
      // Random password: sign-in isn't needed locally. A real one can be set in Settings → Security.
      await registerUser({ name: "Owner", email: "owner@localhost", password: `${randomToken(24)}1a` });
      logger.info("Local mode: created owner account owner@localhost");
    } catch {
      // A concurrent first request created it — fine.
    }
    owner = await db.user.findFirstOrThrow({ orderBy: { createdAt: "asc" }, select: ownerSelect });
  }
  return { ...owner, sessionId: LOCAL_SESSION_ID };
}
