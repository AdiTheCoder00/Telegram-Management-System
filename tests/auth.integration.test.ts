import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, disconnectDb } from "@/lib/db";
import { hashSessionToken, SESSION_COOKIE, SESSION_TTL_MS, validateSessionToken } from "@/lib/auth/session";
import { purgeExpiredSessions, registerUser, registrationOpen } from "@/lib/services/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { randomToken } from "@/lib/crypto";
import * as register from "@/app/api/auth/register/route";
import * as login from "@/app/api/auth/login/route";
import * as logout from "@/app/api/auth/logout/route";
import * as me from "@/app/api/auth/me/route";
import * as password from "@/app/api/auth/password/route";
import * as sessions from "@/app/api/auth/sessions/route";
import * as sessionById from "@/app/api/auth/sessions/[id]/route";
import * as revokeOthers from "@/app/api/auth/sessions/revoke-others/route";

const OWNER = { name: "Owner", email: "owner@levels.test", password: "correct-horse-42" };

function req(path: string, init: { method?: string; body?: unknown; token?: string; ua?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost:3000", "user-agent": init.ua ?? "vitest" };
  if (init.token) headers.cookie = `${SESSION_COOKIE}=${init.token}`;
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) as any });

/** Extracts the session token and cookie attributes from a Set-Cookie header. */
function sessionCookie(res: Response) {
  const raw = res.headers.get("set-cookie") ?? "";
  const token = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
  return { raw, token };
}

async function signIn(ua = "vitest") {
  const res = await login.POST(
    req("/api/auth/login", { method: "POST", body: { email: OWNER.email, password: OWNER.password }, ua }),
    ctx(),
  );
  expect(res.status).toBe(200);
  return sessionCookie(res).token!;
}

const savedAllow = process.env.ALLOW_REGISTRATION;

beforeAll(async () => {
  // Owner-only logic depends on the user count: start this file from an empty user table.
  await db.user.deleteMany();
});
beforeEach(() => {
  resetRateLimits();
  delete process.env.ALLOW_REGISTRATION;
});
afterAll(async () => {
  if (savedAllow === undefined) delete process.env.ALLOW_REGISTRATION;
  else process.env.ALLOW_REGISTRATION = savedAllow;
  await disconnectDb();
});

describe("first-run owner registration", () => {
  it("is open with no users and creates the owner with a secure session cookie", async () => {
    expect(await registrationOpen()).toBe(true);
    const res = await register.POST(req("/api/auth/register", { method: "POST", body: { ...OWNER, timezone: "Europe/London" } }), ctx());
    expect(res.status).toBe(201);
    const { raw, token } = sessionCookie(res);
    expect(token).toBeTruthy();
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=lax/i);
    expect(raw).toMatch(/Path=\//);
    const user = await validateSessionToken(token);
    expect(user?.email).toBe(OWNER.email);
    expect(user?.timezone).toBe("Europe/London");
    // Only the HMAC of the token is stored
    const s = await db.session.findFirstOrThrow({ where: { userId: user!.id } });
    expect(s.tokenHash).toBe(hashSessionToken(token!));
    expect(s.tokenHash).not.toContain(token!);
  });

  it("closes registration once the owner exists", async () => {
    expect(await registrationOpen()).toBe(false);
    const res = await register.POST(
      req("/api/auth/register", { method: "POST", body: { name: "Intruder", email: "x@evil.test", password: "password1234" } }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("registration_closed");
    expect(await db.user.count()).toBe(1);
  });

  it("can be reopened explicitly with ALLOW_REGISTRATION=true", async () => {
    process.env.ALLOW_REGISTRATION = "true";
    const res = await register.POST(
      req("/api/auth/register", { method: "POST", body: { name: "Second", email: "second@levels.test", password: "password1234" } }),
      ctx(),
    );
    expect(res.status).toBe(201);
    await db.user.delete({ where: { email: "second@levels.test" } });
  });

  it("falls back to UTC for an invalid timezone instead of failing", async () => {
    process.env.ALLOW_REGISTRATION = "true";
    const u = await registerUser({ name: "Tz", email: "tz@levels.test", password: "password1234", timezone: undefined });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).timezone).toBe("UTC");
    await db.user.delete({ where: { id: u.id } });
  });

  it("never creates two owners from simultaneous first-run sign-ups", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER.email } });
    const backup = { ...owner };
    await db.user.deleteMany();
    const results = await Promise.allSettled(
      ["a", "b", "c"].map((n) => registerUser({ name: n, email: `${n}@race.test`, password: "password1234" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.user.count()).toBe(1);
    // restore the owner for the remaining tests
    await db.user.deleteMany();
    await db.user.create({
      data: { id: backup.id, email: backup.email, name: backup.name, passwordHash: backup.passwordHash, timezone: backup.timezone },
    });
  });
});

describe("login and logout", () => {
  it("rejects wrong passwords and unknown emails with the same message", async () => {
    const wrong = await login.POST(req("/api/auth/login", { method: "POST", body: { email: OWNER.email, password: "nope" } }), ctx());
    const unknown = await login.POST(
      req("/api/auth/login", { method: "POST", body: { email: "ghost@levels.test", password: "nope" } }),
      ctx(),
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).error).toBe((await unknown.json()).error);
    expect(sessionCookie(wrong).token).toBeUndefined();
  });

  it("rate-limits repeated attempts on one account", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await login.POST(req("/api/auth/login", { method: "POST", body: { email: OWNER.email, password: "nope" } }), ctx())).status;
    }
    expect(last).toBe(429);
  });

  it("signs in, reaches protected endpoints, and signs out", async () => {
    const token = await signIn();
    expect((await me.GET(req("/api/auth/me", { token }), ctx())).status).toBe(200);

    const out = await logout.POST(req("/api/auth/logout", { method: "POST", token }), ctx());
    expect(out.status).toBe(200);
    expect(sessionCookie(out).raw).toMatch(/Max-Age=0/i);
    expect(await validateSessionToken(token)).toBeNull();
    expect((await me.GET(req("/api/auth/me", { token }), ctx())).status).toBe(401);
  });

  it("protects endpoints without a session", async () => {
    expect((await me.GET(req("/api/auth/me"), ctx())).status).toBe(401);
    expect((await sessions.GET(req("/api/auth/sessions", { token: "forged" }), ctx())).status).toBe(401);
  });
});

describe("session lifecycle", () => {
  it("expires idle sessions and slides active ones", async () => {
    const token = await signIn();
    const id = (await validateSessionToken(token))!.sessionId;

    // Close to expiry and stale activity → renewed on use
    await db.session.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date(Date.now() - 3600_000) },
    });
    await validateSessionToken(token);
    const renewed = await db.session.findUniqueOrThrow({ where: { id } });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect(Date.now() - renewed.lastSeenAt.getTime()).toBeLessThan(5_000);

    // Past expiry → rejected and removed
    await db.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSessionToken(token)).toBeNull();
    expect(await db.session.findUnique({ where: { id } })).toBeNull();
  });

  it("keeps the cookie alive longer than the server-side session (DB expiry is authoritative)", async () => {
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email: OWNER.email, password: OWNER.password } }), ctx());
    const maxAge = Number(sessionCookie(res).raw.match(/Max-Age=(\d+)/i)?.[1]);
    expect(maxAge * 1000).toBeGreaterThan(SESSION_TTL_MS);
  });

  it("purges expired sessions", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER.email } });
    await db.session.create({ data: { userId: owner.id, tokenHash: randomToken(), expiresAt: new Date(Date.now() - 1000) } });
    expect(await purgeExpiredSessions()).toBeGreaterThanOrEqual(1);
  });
});

describe("session management", () => {
  it("lists devices, marks the current one, and revokes others", async () => {
    await db.session.deleteMany();
    const laptop = await signIn("Mozilla/5.0 (Windows NT 10.0) Chrome/140");
    const phone = await signIn("Mozilla/5.0 (iPhone) Safari/605 Mobile");

    const list = (await (await sessions.GET(req("/api/auth/sessions", { token: laptop }), ctx())).json()).sessions;
    expect(list).toHaveLength(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const phoneId = (await validateSessionToken(phone))!.sessionId;
    expect(
      (await sessionById.DELETE(req(`/api/auth/sessions/${phoneId}`, { method: "DELETE", token: laptop }), ctx({ id: phoneId }))).status,
    ).toBe(200);
    expect(await validateSessionToken(phone)).toBeNull();

    const tablet = await signIn("tablet");
    const r = await (await revokeOthers.POST(req("/api/auth/sessions/revoke-others", { method: "POST", token: laptop }), ctx())).json();
    expect(r.revoked).toBe(1);
    expect(await validateSessionToken(tablet)).toBeNull();
    expect(await validateSessionToken(laptop)).not.toBeNull();
  });

  it("cannot revoke another user's session", async () => {
    process.env.ALLOW_REGISTRATION = "true";
    const other = await registerUser({ name: "Other", email: "other@levels.test", password: "password1234" });
    const otherSession = await db.session.create({
      data: { userId: other.id, tokenHash: randomToken(), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const token = await signIn();
    const res = await sessionById.DELETE(
      req(`/api/auth/sessions/${otherSession.id}`, { method: "DELETE", token }),
      ctx({ id: otherSession.id }),
    );
    expect(res.status).toBe(404);
    expect(await db.session.findUnique({ where: { id: otherSession.id } })).not.toBeNull();
    await db.user.delete({ where: { id: other.id } });
  });
});

describe("password change", () => {
  it("requires the current password and a strong new one", async () => {
    const token = await signIn();
    const wrong = await password.POST(
      req("/api/auth/password", { method: "POST", token, body: { currentPassword: "nope", newPassword: "another-pass-99" } }),
      ctx(),
    );
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).fieldErrors.currentPassword).toBeTruthy();
    const weak = await password.POST(
      req("/api/auth/password", { method: "POST", token, body: { currentPassword: OWNER.password, newPassword: "short" } }),
      ctx(),
    );
    expect(weak.status).toBe(400);
    expect((await weak.json()).fieldErrors.newPassword).toBeTruthy();
  });

  it("changes the password and signs out every other session", async () => {
    await db.session.deleteMany();
    const here = await signIn();
    const elsewhere = await signIn("other-device");
    const res = await password.POST(
      req("/api/auth/password", {
        method: "POST",
        token: here,
        body: { currentPassword: OWNER.password, newPassword: "brand-new-pass-77" },
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).revokedSessions).toBe(1);
    expect(await validateSessionToken(here)).not.toBeNull();
    expect(await validateSessionToken(elsewhere)).toBeNull();

    resetRateLimits();
    const oldPw = await login.POST(
      req("/api/auth/login", { method: "POST", body: { email: OWNER.email, password: OWNER.password } }),
      ctx(),
    );
    expect(oldPw.status).toBe(401);
    const newPw = await login.POST(
      req("/api/auth/login", { method: "POST", body: { email: OWNER.email, password: "brand-new-pass-77" } }),
      ctx(),
    );
    expect(newPw.status).toBe(200);
  });
});
