import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { processPriceTick } from "@/lib/engine/engine";
import { processDelivery, sweepDueDeliveries } from "@/lib/notifications/delivery";
import { startMockTelegram, type MockTelegram } from "./helpers/mock-telegram";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let tg: MockTelegram;
let userId: string;
let botId: string;
let t = Date.parse("2026-10-03T14:00:00Z");
const nextTime = () => new Date((t += 1000));

async function tick(symbol: string, price: number, scope?: string) {
  const r = await processPriceTick({ provider: "webhook", scope: scope ?? userId, symbol, price, time: nextTime() });
  for (const x of r.triggered) if (x.deliveryId) await processDelivery(x.deliveryId);
  return r;
}

beforeAll(async () => {
  tg = await startMockTelegram();
  process.env.TELEGRAM_API_URL = tg.url;
  const u = await makeUser();
  userId = u.id;
  botId = (await makeBot(userId)).id;
});

afterAll(async () => {
  await tg.close();
  await disconnectDb();
});

beforeEach(() => {
  tg.sent.length = 0;
  tg.mode = "ok";
});

describe("alert engine + delivery (end to end against Postgres)", () => {
  it("3895 → 3901 triggers exactly one Telegram message, recorded in history", async () => {
    const a = await makeAlert(userId, botId);
    await tick(a.symbol, 3895);
    const r = await tick(a.symbol, 3901);
    expect(r.triggered).toHaveLength(1);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain(`Symbol: ${a.symbol}`);
    expect(tg.sent[0].text).toContain("Current Price: 3901");

    // Repeated updates above target do not spam
    for (const p of [3901, 3902, 3903.5, 3901]) await tick(a.symbol, p);
    expect(tg.sent).toHaveLength(1);

    const events = await db.alertEvent.findMany({ where: { alertId: a.id }, include: { deliveries: true } });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("SENT");
    expect(events[0].triggerPrice).toBe(3901);
    expect(events[0].deliveries[0].telegramMessageId).toBeTruthy();
  });

  it("re-arms after price returns below target", async () => {
    const a = await makeAlert(userId, botId);
    for (const p of [3895, 3901, 3895, 3902]) await tick(a.symbol, p);
    expect(tg.sent).toHaveLength(2);
  });

  it("paused alerts do not trigger", async () => {
    const a = await makeAlert(userId, botId, { status: "PAUSED" });
    for (const p of [3895, 3901]) await tick(a.symbol, p);
    expect(tg.sent).toHaveLength(0);
  });

  it("duplicate ticks (same timestamp and price) and stale ticks are ignored", async () => {
    const a = await makeAlert(userId, botId);
    const time = nextTime();
    const r1 = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3901, time });
    const r2 = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3901, time });
    const r3 = await processPriceTick({
      provider: "webhook",
      scope: userId,
      symbol: a.symbol,
      price: 3950,
      time: new Date(time.getTime() - 5000),
    });
    expect(r1.quote).toBe("new");
    expect(r2.quote).toBe("duplicate");
    expect(r3.quote).toBe("stale");
    expect(r1.triggered).toHaveLength(1);
  });

  it("concurrent ticks never double-trigger the same alert (optimistic locking)", async () => {
    const a = await makeAlert(userId, botId);
    await tick(a.symbol, 3895);
    const results = await Promise.all(
      [3901, 3902, 3903, 3904, 3905].map((p, i) =>
        processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: p, time: new Date(t + 1000 + i) }),
      ),
    );
    t += 2000;
    const triggered = results.flatMap((r) => r.triggered);
    expect(triggered).toHaveLength(1);
    expect(await db.alertEvent.count({ where: { alertId: a.id } })).toBe(1);
  });

  it("multiple alerts on the same symbol trigger independently at the same instant", async () => {
    const first = await makeAlert(userId, botId);
    const second = await makeAlert(userId, botId, { symbol: first.symbol, name: "Second", targetPrice: 3800 });
    const third = await makeAlert(userId, botId, { symbol: first.symbol, name: "Below", conditionType: "PRICE_BELOW", targetPrice: 3000 });
    const r = await tick(first.symbol, 3950);
    expect(r.triggered.map((x) => x.alertId).sort()).toEqual([first.id, second.id].sort());
    expect(r.triggered.find((x) => x.alertId === third.id)).toBeUndefined();
  });

  it("user-scoped ticks only affect that user's alerts", async () => {
    const other = await makeUser();
    const otherBot = await makeBot(other.id);
    const mine = await makeAlert(userId, botId);
    const theirs = await makeAlert(other.id, otherBot.id, { symbol: mine.symbol });
    const r = await tick(mine.symbol, 3950, userId);
    expect(r.triggered.map((x) => x.alertId)).toEqual([mine.id]);
    expect(r.triggered.find((x) => x.alertId === theirs.id)).toBeUndefined();
  });
});

describe("Telegram delivery", () => {
  it("retries when Telegram is unavailable and succeeds later", async () => {
    const a = await makeAlert(userId, botId);
    tg.mode = "down";
    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3950, time: nextTime() });
    const id = r.triggered[0].deliveryId!;
    const out = await processDelivery(id);
    expect(out.status).toBe("retry");
    let d = await db.telegramDelivery.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe("PENDING");
    expect(d.error).toMatch(/temporarily unavailable/i);

    // Worker restart / sweep picks it up once due
    tg.mode = "ok";
    await db.telegramDelivery.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await sweepDueDeliveries()).toBeGreaterThanOrEqual(1);
    d = await db.telegramDelivery.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe("SENT");
    // (the sweep may also deliver PENDING rows left by earlier tests — exactly one message is for this alert)
    expect(tg.sent.filter((m) => m.text.includes(a.symbol))).toHaveLength(1);
  });

  it("fails permanently with a friendly error for an invalid chat id and flags the bot", async () => {
    const bot = await makeBot(userId, { chatId: "-100999" });
    const a = await makeAlert(userId, bot.id);
    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3950, time: nextTime() });
    const out = await processDelivery(r.triggered[0].deliveryId!);
    expect(out.status).toBe("failed");
    const d = await db.telegramDelivery.findUniqueOrThrow({ where: { id: r.triggered[0].deliveryId! } });
    expect(d.error).toMatch(/could not find that chat/i);
    expect(d.errorDetail).toMatch(/chat not found/);
    expect((await db.telegramBot.findUniqueOrThrow({ where: { id: bot.id } })).status).toBe("ERROR");
    expect((await db.alertEvent.findUniqueOrThrow({ where: { id: r.triggered[0].eventId } })).status).toBe("FAILED");
  });

  it("an invalid token is reported without leaking the token", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const bad = "987654321:AAbadbadbadbadbadbadbadbadbadbadbad";
    const bot = await makeBot(userId, { encryptedToken: encrypt(bad) });
    const a = await makeAlert(userId, bot.id);
    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3950, time: nextTime() });
    const out = await processDelivery(r.triggered[0].deliveryId!);
    expect(out.status).toBe("failed");
    const d = await db.telegramDelivery.findUniqueOrThrow({ where: { id: r.triggered[0].deliveryId! } });
    expect(d.error).toMatch(/bot token/i);
    expect(JSON.stringify(d)).not.toContain(bad);
  });

  it("deliveries are idempotent: processing twice sends once", async () => {
    const a = await makeAlert(userId, botId);
    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3950, time: nextTime() });
    const id = r.triggered[0].deliveryId!;
    const [x, y] = await Promise.all([processDelivery(id), processDelivery(id)]);
    expect([x.status, y.status].sort()).toEqual(["sent", "skipped"]);
    expect(tg.sent).toHaveLength(1);
  });

  it("falls back to plain text when MarkdownV2 formatting is invalid", async () => {
    const a = await makeAlert(userId, botId, { parseMode: "MARKDOWN_V2", messageTemplate: "Price hit {{current_price}}. Go!" });
    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: a.symbol, price: 3950, time: nextTime() });
    const out = await processDelivery(r.triggered[0].deliveryId!);
    expect(out.status).toBe("sent");
    expect(tg.sent[0].parse_mode).toBeUndefined();
  });

  it("deleting a bot keeps history and flags dependent alerts", async () => {
    const { deleteBot } = await import("@/lib/services/bots");
    const bot = await makeBot(userId);
    const a = await makeAlert(userId, bot.id);
    await tick(a.symbol, 3950);
    const res = await deleteBot(userId, bot.id);
    expect(res.affectedAlerts).toBe(1);
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe("ERROR");
    expect(after.telegramBotId).toBeNull();
    expect(await db.alertEvent.count({ where: { alertId: a.id } })).toBe(1);
  });
});
