import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, disconnectDb } from "@/lib/db";
import { createWebhook, ingestWebhook, parseInterval, parsePayload, parseTime, setWebhookEnabled } from "@/lib/services/webhooks";
import { handleWebhook } from "@/lib/webhook-ingest";
import { getSeries } from "@/lib/market/service";
import { evaluateConditionAlert } from "@/lib/engine/condition-engine";
import { processDelivery } from "@/lib/notifications/delivery";
import { resetRateLimits } from "@/lib/rate-limit";
import type { ConditionNode } from "@/lib/conditions/types";
import { startMockTelegram, type MockTelegram } from "./helpers/mock-telegram";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let tg: MockTelegram;
let userId: string;
let botId: string;
const M5 = 300_000;

beforeAll(async () => {
  tg = await startMockTelegram();
  process.env.TELEGRAM_API_URL = tg.url;
  userId = (await makeUser()).id;
  botId = (await makeBot(userId)).id;
});

afterAll(async () => {
  await tg.close();
  await disconnectDb();
});

beforeEach(() => {
  tg.sent.length = 0;
  resetRateLimits();
});

const req = (url: string, body: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "POST", body, headers: { "content-type": "text/plain", ...headers } });

describe("webhook payload parsing", () => {
  it("understands TradingView intervals and times", () => {
    expect(parseInterval("5")).toBe("5m");
    expect(parseInterval("60")).toBe("1h");
    expect(parseInterval("240")).toBe("4h");
    expect(parseInterval("D")).toBe("1d");
    expect(parseInterval("1W")).toBe("1w");
    expect(parseInterval("15m")).toBe("15m");
    expect(parseInterval("7")).toBeNull();
    expect(parseTime("2026-10-05T10:00:00Z")).toBe(Date.UTC(2026, 9, 5, 10));
    expect(parseTime(1791194400)).toBe(1791194400_000); // epoch seconds
    expect(parseTime(1791194400000)).toBe(1791194400000);
  });

  it("parses ticks and bars, strips exchange prefixes, rejects bad items with reasons", () => {
    const now = Date.UTC(2026, 9, 5, 10, 7);
    const { items, errors } = parsePayload(
      JSON.stringify([
        { ticker: "OANDA:XAUUSD", price: "3901.5" },
        { symbol: "XAUUSD", interval: "5", time: "2026-10-05T10:00:00Z", open: 1, high: 3, low: 0.5, close: 2, volume: 10 },
        { symbol: "XAUUSD", interval: "5", time: "2026-10-05T10:00:00Z", open: 1, high: 0.9, low: 0.5, close: 2 }, // high < close
        { symbol: "XAUUSD" },
        { symbol: "XAUUSD", price: 1, timestamp: "2030-01-01T00:00:00Z" },
      ]),
      now,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "tick", symbol: "XAUUSD", price: 3901.5 });
    expect(items[1]).toMatchObject({ type: "bar", timeframe: "5m", openTime: Date.UTC(2026, 9, 5, 10), close: 2, volume: 10 });
    expect(errors).toHaveLength(3);
    expect(errors.join(" ")).toMatch(/future/);
  });

  it("rejects non-JSON and oversized bodies", () => {
    expect(() => parsePayload("XAUUSD 3900")).toThrow(/JSON/);
    expect(() => parsePayload(JSON.stringify({ symbol: "X", price: 1, pad: "x".repeat(70_000) }))).toThrow(/too large/i);
  });
});

describe("webhook ingestion (against Postgres)", () => {
  it("authenticates by secret; disabled or wrong secrets are rejected; the secret is never echoed", async () => {
    const w = await createWebhook(userId, { name: "TV", kind: "TRADINGVIEW" });
    const ok = await handleWebhook(
      req("http://localhost/api/webhooks/tradingview/x", JSON.stringify({ symbol: "WHKA", price: 10 })),
      w.secret,
    );
    expect(ok.status).toBe(202);
    expect(await ok.text()).not.toContain(w.secret);

    const bad = await handleWebhook(req("http://localhost/x", "{}"), "whk_wrong");
    expect(bad.status).toBe(401);
    // A valid secret used against a different webhook id is rejected (generic route).
    const mismatch = await handleWebhook(req("http://localhost/x", JSON.stringify({ symbol: "WHKA", price: 11 })), w.secret, "other-id");
    expect(mismatch.status).toBe(401);

    await setWebhookEnabled(userId, w.id, false);
    const disabled = await handleWebhook(req("http://localhost/x", JSON.stringify({ symbol: "WHKA", price: 12 })), w.secret);
    expect(disabled.status).toBe(401);
    expect((await db.webhook.findUniqueOrThrow({ where: { id: w.id } })).secretHash).not.toContain(w.secret);
  });

  it("a price alert on the webhook provider triggers from a pushed tick exactly once (idempotent ids)", async () => {
    const w = await createWebhook(userId, { name: "TV", kind: "TRADINGVIEW" });
    const a = await makeAlert(userId, botId, { symbol: "WHKB", targetPrice: 100, triggerMode: "ONCE", status: "ACTIVE" });
    await ingestWebhook({ id: w.id, userId }, JSON.stringify({ symbol: "WHKB", price: 99, id: "t1" }));
    const r1 = await ingestWebhook({ id: w.id, userId }, JSON.stringify({ symbol: "WHKB", price: 101, id: "t2" }));
    expect(r1.triggered).toBe(1);
    const r2 = await ingestWebhook({ id: w.id, userId }, JSON.stringify({ symbol: "WHKB", price: 101, id: "t2" })); // TradingView retry
    expect(r2.duplicates).toBe(1);
    expect(r2.triggered).toBe(0);
    for (const id of r1.deliveryIds) await processDelivery(id);
    expect(tg.sent).toHaveLength(1);
    expect(await db.alertEvent.count({ where: { alertId: a.id } })).toBe(1);
  });

  it("pushed bars become the candles condition alerts read (same engine as polled data)", async () => {
    const w = await createWebhook(userId, { name: "TV bars", kind: "TRADINGVIEW" });
    const start = Date.UTC(2026, 9, 5, 10, 0);
    const closes = [99, 99, 99, 101];
    const bars = closes.map((c, i) => ({
      symbol: "WHKC",
      interval: "5",
      time: new Date(start + i * M5).toISOString(),
      open: i ? closes[i - 1] : c,
      high: Math.max(c, i ? closes[i - 1] : c) + 0.5,
      low: Math.min(c, i ? closes[i - 1] : c) - 0.5,
      close: c,
    }));
    const now = start + 4 * M5 + 5_000;
    const out = await ingestWebhook({ id: w.id, userId }, JSON.stringify(bars), now);
    expect(out.bars).toBe(4);
    // Re-sending the same bars is a no-op.
    expect((await ingestWebhook({ id: w.id, userId }, JSON.stringify(bars), now)).duplicates).toBe(4);

    const series = await getSeries({ provider: "webhook", scope: userId, symbol: "WHKC", timeframe: "5m", asOf: now, bars: 4 });
    expect(series.source).toBe("pushed");
    expect(series.candles.map((c) => c.close)).toEqual(closes);
    // No fake 1m tick candles were created from the bars' closes.
    expect(await db.candle.count({ where: { provider: "webhook", scope: userId, symbol: "WHKC", volumeType: "TICK" } })).toBe(0);

    const tree: ConditionNode = {
      id: "r",
      type: "compare",
      left: { kind: "price", field: "close" },
      op: ">",
      right: { kind: "value", value: 100 },
    };
    const a = await makeAlert(userId, botId, {
      symbol: "WHKC",
      kind: "CONDITIONS",
      timeframe: "5m",
      evaluationMode: "CANDLE_CLOSE",
      conditionTree: tree as object,
      status: "ACTIVE",
    });
    const alert = await db.alert.findUniqueOrThrow({ where: { id: a.id }, include: { bot: true, user: { select: { timezone: true } } } });
    const r = await evaluateConditionAlert(alert, new Date(now));
    expect(r.triggered).toHaveLength(1);
    const ev = await db.triggerEvidence.findFirstOrThrow({ where: { alertId: a.id } });
    expect(ev.candleOpenTime?.getTime()).toBe(start + 3 * M5);
    expect((ev.providerMeta as Record<string, { source: string }>)["5m"].source).toBe("pushed");
  });
});
