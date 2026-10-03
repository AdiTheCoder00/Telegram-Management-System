import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, disconnectDb } from "@/lib/db";
import { randomToken, encrypt, decrypt } from "@/lib/crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { hashSessionToken, SESSION_COOKIE, validateSessionToken } from "@/lib/auth/session";
import { resetRateLimits } from "@/lib/rate-limit";
import { alertInputSchema, registerSchema } from "@/lib/validation";
import { createApiKey } from "@/lib/services/api-keys";
import { serializeBot } from "@/lib/services/bots";
import * as alertsRoute from "@/app/api/alerts/route";
import * as alertRoute from "@/app/api/alerts/[id]/route";
import * as webhookRoute from "@/app/api/webhooks/price/route";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";
import { DEFAULT_TEMPLATE } from "@/lib/constants";

const BASE = "http://localhost:3000";
let userId: string;
let botId: string;
let sessionToken: string;

function req(path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost:3000", ...init.headers };
  if (init.token !== null) headers.cookie = `${SESSION_COOKIE}=${init.token ?? sessionToken}`;
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) as any });

const validAlert = () => ({
  name: "Gold Breakout Alert",
  symbol: "xauusd",
  dataProvider: "simulated",
  conditionType: "PRICE_ABOVE",
  targetPrice: 3900,
  telegramBotId: botId,
  messageTemplate: DEFAULT_TEMPLATE,
  parseMode: "PLAIN",
  triggerMode: "REARM",
  cooldownSeconds: 60,
  expiryType: "NEVER",
});

beforeAll(async () => {
  const u = await makeUser();
  userId = u.id;
  botId = (await makeBot(userId)).id;
  sessionToken = randomToken(32);
  await db.session.create({ data: { userId, tokenHash: hashSessionToken(sessionToken), expiresAt: new Date(Date.now() + 3600_000) } });
});

afterAll(() => disconnectDb());

describe("authentication", () => {
  it("hashes passwords with bcrypt and verifies them", async () => {
    const hash = await hashPassword("correct horse 42");
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword("correct horse 42", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("validates session tokens and rejects expired / unknown ones", async () => {
    expect((await validateSessionToken(sessionToken))?.id).toBe(userId);
    expect(await validateSessionToken("nope")).toBeNull();
    const expired = randomToken(32);
    await db.session.create({ data: { userId, tokenHash: hashSessionToken(expired), expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSessionToken(expired)).toBeNull();
  });

  it("rejects unauthenticated API requests with 401", async () => {
    const res = await alertsRoute.GET(req("/api/alerts", { token: null }), ctx());
    expect(res.status).toBe(401);
    const res2 = await alertsRoute.POST(req("/api/alerts", { method: "POST", body: validAlert(), token: "forged" }), ctx());
    expect(res2.status).toBe(401);
  });

  it("enforces password strength on registration", () => {
    expect(registerSchema.safeParse({ name: "a", email: "a@b.co", password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ name: "a", email: "a@b.co", password: "longenough1" }).success).toBe(true);
  });
});

describe("authorization & CSRF", () => {
  it("users cannot read or modify other users' alerts", async () => {
    const other = await makeUser();
    const theirs = await makeAlert(other.id, null);
    const res = await alertRoute.GET(req(`/api/alerts/${theirs.id}`), ctx({ id: theirs.id }));
    expect(res.status).toBe(404);
    const del = await alertRoute.DELETE(req(`/api/alerts/${theirs.id}`, { method: "DELETE" }), ctx({ id: theirs.id }));
    expect(del.status).toBe(404);
    expect(await db.alert.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });

  it("cannot attach another user's bot to an alert", async () => {
    const other = await makeUser();
    const theirBot = await makeBot(other.id);
    const res = await alertsRoute.POST(
      req("/api/alerts", { method: "POST", body: { ...validAlert(), telegramBotId: theirBot.id } }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it("blocks cross-site state-changing requests", async () => {
    const res = await alertsRoute.POST(
      req("/api/alerts", {
        method: "POST",
        body: validAlert(),
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      }),
      ctx(),
    );
    expect(res.status).toBe(403);
  });
});

describe("API validation", () => {
  it("creates a valid alert (symbol normalised to upper case)", async () => {
    const res = await alertsRoute.POST(req("/api/alerts", { method: "POST", body: validAlert() }), ctx());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.alert.symbol).toBe("XAUUSD");
    expect(json.alert.status).toBe("ACTIVE");
  });

  it("returns field errors for invalid input", async () => {
    const res = await alertsRoute.POST(
      req("/api/alerts", { method: "POST", body: { ...validAlert(), targetPrice: -5, symbol: "bad symbol!", conditionType: "NOPE" } }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.fieldErrors.targetPrice).toBeTruthy();
    expect(json.fieldErrors.symbol).toBeTruthy();
    expect(json.fieldErrors.conditionType).toBeTruthy();
  });

  it("rejects templates with unknown variables or broken formatting", async () => {
    const r1 = await alertsRoute.POST(
      req("/api/alerts", { method: "POST", body: { ...validAlert(), messageTemplate: "{{nope}}" } }),
      ctx(),
    );
    expect(r1.status).toBe(400);
    const r2 = await alertsRoute.POST(
      req("/api/alerts", { method: "POST", body: { ...validAlert(), parseMode: "HTML", messageTemplate: "<b>{{symbol}}" } }),
      ctx(),
    );
    expect(r2.status).toBe(400);
  });

  it("requires expiry details when chosen", () => {
    expect(alertInputSchema.safeParse({ ...validAlert(), expiryType: "AT_DATE" }).success).toBe(false);
    expect(alertInputSchema.safeParse({ ...validAlert(), expiryType: "AFTER_N_TRIGGERS" }).success).toBe(false);
    expect(alertInputSchema.safeParse({ ...validAlert(), expiryType: "AFTER_N_TRIGGERS", maxTriggers: 3 }).success).toBe(true);
  });

  it("returns a friendly error for malformed JSON", async () => {
    const r = new NextRequest(`${BASE}/api/alerts`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, host: "localhost:3000", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await alertsRoute.POST(r, ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid JSON/);
  });
});

describe("secrets", () => {
  it("encrypts bot tokens at rest and never serialises them", async () => {
    const token = "123456789:AAH-valid-token-for-tests-0123456789ab";
    const enc = encrypt(token);
    expect(enc).not.toContain(token);
    expect(decrypt(enc)).toBe(token);
    const bot = await db.telegramBot.findUniqueOrThrow({ where: { id: botId } });
    const dto = serializeBot(bot);
    expect(JSON.stringify(dto)).not.toContain(bot.encryptedToken);
    expect(JSON.stringify(dto)).not.toContain(token);
    expect(dto.tokenHint).toBe("••••89ab");
  });
});

describe("webhook authentication", () => {
  const hook = (body: unknown, headers: Record<string, string> = {}) =>
    webhookRoute.POST(req("/api/webhooks/price", { method: "POST", body, token: null, headers }));

  it("rejects missing and invalid credentials", async () => {
    resetRateLimits();
    expect((await hook({ symbol: "XAUUSD", price: 3901 })).status).toBe(401);
    expect((await hook({ symbol: "XAUUSD", price: 3901 }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await hook({ symbol: "XAUUSD", price: 3901 }, { "x-api-key": "tam_forged" })).status).toBe(401);
  });

  it("accepts the global secret and user API keys; revoked keys stop working", async () => {
    const g = await hook({ symbol: "WHTEST", price: 10 }, { "x-webhook-secret": process.env.WEBHOOK_SECRET! });
    expect(g.status).toBe(202);
    const key = await createApiKey(userId, "tv");
    const u = await hook({ symbol: "WHTEST", price: 11 }, { authorization: `Bearer ${key.key}` });
    expect(u.status).toBe(202);
    await db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    expect((await hook({ symbol: "WHTEST", price: 12 }, { authorization: `Bearer ${key.key}` })).status).toBe(401);
  });

  it("validates payloads and ignores duplicate webhook deliveries", async () => {
    const key = await createApiKey(userId, "dup");
    const h = { authorization: `Bearer ${key.key}` };
    expect((await hook({ symbol: "XAUUSD", price: "abc" }, h)).status).toBe(400);
    const a = await makeAlert(userId, botId);
    const body = { symbol: a.symbol, price: 3950, timestamp: "2026-10-03T14:35:00Z", id: "tv-evt-1" };
    const first = await (await hook(body, h)).json();
    const second = await (await hook(body, h)).json();
    expect(first.triggered).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(second.triggered).toBe(0);
    expect(await db.alertEvent.count({ where: { alertId: a.id } })).toBe(1);
  });
});
