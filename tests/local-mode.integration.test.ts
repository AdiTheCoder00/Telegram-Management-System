import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, disconnectDb } from "@/lib/db";
import { getLocalOwner, isLoopbackHost, localAccessAllowed, LOCAL_SESSION_ID } from "@/lib/auth/local-mode";
import { checkEnv } from "@/lib/env";
import { resetRateLimits } from "@/lib/rate-limit";
import * as me from "@/app/api/auth/me/route";
import * as password from "@/app/api/auth/password/route";
import * as alerts from "@/app/api/alerts/route";
import { proxy } from "@/proxy";

const saved = { AUTH_MODE: process.env.AUTH_MODE, LEVELS_LOOPBACK_ONLY: process.env.LEVELS_LOOPBACK_ONLY };

function req(path: string, host: string, init: { method?: string; body?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = { host, "content-type": "application/json" };
  if (init.origin) headers.origin = init.origin;
  return new NextRequest(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = () => ({ params: Promise.resolve({}) as any });

function localMode(on: boolean, loopbackLauncher = true) {
  process.env.AUTH_MODE = on ? "local" : "password";
  process.env.LEVELS_LOOPBACK_ONLY = loopbackLauncher ? "1" : "";
}

beforeAll(async () => {
  resetRateLimits();
  await db.user.deleteMany();
});
afterEach(() => {
  process.env.AUTH_MODE = saved.AUTH_MODE;
  process.env.LEVELS_LOOPBACK_ONLY = saved.LEVELS_LOOPBACK_ONLY;
});
afterAll(() => disconnectDb());

describe("local-mode gating", () => {
  it("recognises only loopback hosts", () => {
    for (const h of ["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["192.168.31.9:3000", "evil.com", "localhost.evil.com", "127.0.0.1.nip.io", "", null])
      expect(isLoopbackHost(h)).toBe(false);
  });

  it("requires AUTH_MODE=local AND the loopback launcher AND a loopback Host", () => {
    localMode(true);
    expect(localAccessAllowed("localhost:3000")).toBe(true);
    expect(localAccessAllowed("192.168.31.9:3000")).toBe(false); // other machine / DNS rebinding
    localMode(true, false); // e.g. Docker or plain `next start`
    expect(localAccessAllowed("localhost:3000")).toBe(false);
    localMode(false);
    expect(localAccessAllowed("localhost:3000")).toBe(false);
  });
});

describe("local-mode access", () => {
  it("creates the owner on first run and reaches protected APIs without a cookie", async () => {
    localMode(true);
    expect(await db.user.count()).toBe(0);
    const res = await me.GET(req("/api/auth/me", "localhost:3000"), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("owner@localhost");
    expect(await db.user.count()).toBe(1);
    // Repeated / concurrent requests reuse the same owner
    await Promise.all([1, 2, 3].map(() => getLocalOwner()));
    expect(await db.user.count()).toBe(1);
  });

  it("still requires sign-in from a non-loopback Host, even in local mode", async () => {
    localMode(true);
    expect((await me.GET(req("/api/auth/me", "192.168.31.9:3000"), ctx())).status).toBe(401);
  });

  it("still requires sign-in when the server was not started loopback-only", async () => {
    localMode(true, false);
    expect((await me.GET(req("/api/auth/me", "localhost:3000"), ctx())).status).toBe(401);
  });

  it("keeps CSRF protection for state-changing requests from other sites", async () => {
    localMode(true);
    const res = await alerts.POST(req("/api/alerts", "localhost:3000", { method: "POST", body: {}, origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
  });

  it("lets the local owner set a password without the current one", async () => {
    localMode(true);
    const res = await password.POST(
      req("/api/auth/password", "localhost:3000", { method: "POST", body: { newPassword: "local-owner-pass-1" } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect((await getLocalOwner()).sessionId).toBe(LOCAL_SESSION_ID);
  });
});

describe("proxy (route guard)", () => {
  it("skips the login redirect locally and sends /login to the dashboard", () => {
    localMode(true);
    expect(proxy(req("/dashboard", "localhost:3000")).headers.get("location")).toBeNull();
    expect(proxy(req("/login", "localhost:3000")).headers.get("location")).toMatch(/\/dashboard$/);
  });

  it("redirects to /login when local access does not apply", () => {
    localMode(true);
    expect(proxy(req("/dashboard", "192.168.31.9:3000")).headers.get("location")).toMatch(/\/login\?next=%2Fdashboard$/);
    localMode(false);
    expect(proxy(req("/dashboard", "localhost:3000")).headers.get("location")).toMatch(/\/login/);
  });
});

describe("configuration", () => {
  it("warns that AUTH_MODE=local is ignored without the loopback launcher, and rejects unknown modes", () => {
    localMode(true, false);
    expect(checkEnv().warnings.join(" ")).toMatch(/AUTH_MODE=local is ignored/);
    process.env.AUTH_MODE = "none";
    expect(checkEnv().errors.join(" ")).toMatch(/AUTH_MODE must be/);
  });
});
