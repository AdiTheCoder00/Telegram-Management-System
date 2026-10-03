import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { checkDatabase, checkMarketData, checkRedis, checkWorkers, maxQuoteAgeMs } from "@/lib/health";
import { checkEnv } from "@/lib/env";
import { GLOBAL_SCOPE } from "@/lib/engine/quotes";
import * as healthRoute from "@/app/api/health/route";
import * as marketRoute from "@/app/api/health/market-data/route";
import { makeAlert, makeUser } from "./helpers/fixtures";

let userId: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  // Health is global: start from a clean slate of feeds and heartbeats.
  await db.alert.updateMany({ data: { status: "PAUSED" } });
  await db.workerHeartbeat.deleteMany();
  userId = (await makeUser()).id;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

afterAll(() => disconnectDb());

describe("health: database", () => {
  it("reports CONNECTED with latency", async () => {
    const h = await checkDatabase();
    expect(h.status).toBe("CONNECTED");
    expect(typeof h.latencyMs).toBe("number");
  });
});

describe("health: redis", () => {
  it("reports NOT_CONFIGURED (not CONNECTED) when REDIS_URL is unset", async () => {
    process.env.REDIS_URL = "";
    expect((await checkRedis()).status).toBe("NOT_CONFIGURED");
  });

  it("reports DISCONNECTED quickly when Redis is unreachable", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const t = Date.now();
    expect((await checkRedis()).status).toBe("DISCONNECTED");
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});

describe("health: workers", () => {
  it("is STOPPED without a recent heartbeat and RUNNING with one", async () => {
    await db.workerHeartbeat.create({ data: { id: "old:1", startedAt: new Date(0), lastSeenAt: new Date(Date.now() - 120_000) } });
    expect((await checkWorkers()).status).toBe("STOPPED");
    await db.workerHeartbeat.create({ data: { id: "live:1", startedAt: new Date(), lastSeenAt: new Date() } });
    expect((await checkWorkers()).status).toBe("RUNNING");
    await db.workerHeartbeat.deleteMany();
  });
});

describe("health: market data", () => {
  it("is NOT_CONFIGURED with no active alerts", async () => {
    expect((await checkMarketData()).status).toBe("NOT_CONFIGURED");
  });

  it("distinguishes fresh, stale and simulated feeds — simulated is never reported as live", async () => {
    const fresh = await makeAlert(userId, null, { dataProvider: "binance", symbol: "HFRESH" });
    const stale = await makeAlert(userId, null, { dataProvider: "binance", symbol: "HSTALE" });
    const sim = await makeAlert(userId, null, { dataProvider: "simulated", symbol: "HSIM" });
    const old = new Date(Date.now() - maxQuoteAgeMs() - 60_000);
    await db.quote.createMany({
      data: [
        { provider: "binance", scope: GLOBAL_SCOPE, symbol: "HFRESH", price: 1, sourceTime: new Date(), updatedAt: new Date() },
        { provider: "binance", scope: GLOBAL_SCOPE, symbol: "HSTALE", price: 1, sourceTime: old, updatedAt: old },
      ],
    });

    const h = await checkMarketData();
    const feeds = h.feeds as { symbol: string; state: string }[];
    expect(feeds.find((f) => f.symbol === "HFRESH")?.state).toBe("FRESH");
    expect(feeds.find((f) => f.symbol === "HSTALE")?.state).toBe("STALE");
    expect(feeds.find((f) => f.symbol === "HSIM")?.state).toBe("SIMULATED");
    expect(h.status).toBe("DEGRADED");

    // Only stale polled data → STALE and HTTP 503
    await db.alert.updateMany({ where: { id: { in: [fresh.id, sim.id] } }, data: { status: "PAUSED" } });
    expect((await checkMarketData()).status).toBe("STALE");
    expect((await marketRoute.GET()).status).toBe(503);

    // Only fresh data → CONNECTED
    await db.alert.updateMany({ where: { id: stale.id }, data: { status: "PAUSED" } });
    await db.alert.updateMany({ where: { id: fresh.id }, data: { status: "ACTIVE" } });
    expect((await checkMarketData()).status).toBe("CONNECTED");
    await db.alert.updateMany({ where: { id: fresh.id }, data: { status: "PAUSED" } });
  });
});

describe("aggregate /api/health", () => {
  it("returns 200 DEGRADED when the database is up but no worker is running", async () => {
    process.env.REDIS_URL = "";
    const res = await healthRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("DEGRADED");
    expect(body.checks).toMatchObject({ database: "CONNECTED", redis: "NOT_CONFIGURED", workers: "STOPPED" });
  });
});

describe("environment validation", () => {
  it("refuses production without real secrets", () => {
    Object.assign(process.env, { NODE_ENV: "production", NEXTAUTH_SECRET: "", ENCRYPTION_KEY: "" });
    const r = checkEnv();
    expect(r.errors.join(" ")).toMatch(/NEXTAUTH_SECRET/);
    expect(r.errors.join(" ")).toMatch(/ENCRYPTION_KEY/);
  });

  it("only warns in development", () => {
    Object.assign(process.env, { NODE_ENV: "development", NEXTAUTH_SECRET: "", ENCRYPTION_KEY: "" });
    const r = checkEnv();
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("rejects malformed values in any environment", () => {
    Object.assign(process.env, { ENCRYPTION_KEY: "too-short", REDIS_URL: "localhost:6379", APP_URL: "example.com" });
    const errs = checkEnv().errors.join(" ");
    expect(errs).toMatch(/ENCRYPTION_KEY must be 32 bytes/);
    expect(errs).toMatch(/REDIS_URL/);
    expect(errs).toMatch(/APP_URL/);
  });

  it("accepts a complete production configuration", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXTAUTH_SECRET: "x".repeat(32),
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      APP_URL: "https://alerts.example.com",
      REDIS_URL: "redis://localhost:6379",
      TELEGRAM_API_URL: "https://api.telegram.org",
    });
    expect(checkEnv().errors).toEqual([]);
  });
});
