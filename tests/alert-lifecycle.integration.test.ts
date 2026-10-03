import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { processPriceTick, expireDueAlerts } from "@/lib/engine/engine";
import { createAlert, listAlerts, resumeAlert, updateAlert } from "@/lib/services/alerts";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import { startMockTelegram, type MockTelegram } from "./helpers/mock-telegram";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let tg: MockTelegram;
let userId: string;
let botId: string;
let t = Date.parse("2026-10-04T09:00:00Z");
const nextTime = () => new Date((t += 1000));

async function tick(symbol: string, price: number) {
  return processPriceTick({ provider: "webhook", scope: userId, symbol, price, time: nextTime() });
}

const input = (over: Record<string, unknown> = {}) => ({
  name: "Lifecycle Alert",
  symbol: `LC${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  dataProvider: "webhook",
  conditionType: "PRICE_ABOVE" as const,
  targetPrice: 3900,
  tolerance: 0,
  telegramBotId: botId,
  messageTemplate: DEFAULT_TEMPLATE,
  parseMode: "PLAIN" as const,
  triggerMode: "REARM" as const,
  cooldownSeconds: 0,
  expiryType: "NEVER" as const,
  expiresAt: null,
  maxTriggers: null,
  status: "ACTIVE" as const,
  ...over,
});

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

describe("DRAFT alerts (created but not activated)", () => {
  it("can be created without a bot and never trigger until activated", async () => {
    const alert = await createAlert(userId, input({ status: "DRAFT", telegramBotId: null }));
    expect(alert.status).toBe("DRAFT");

    const r = await tick(alert.symbol, 3950);
    expect(r.triggered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("DRAFT");
  });

  it("activation requires a bot, and passes once one is assigned", async () => {
    const alert = await createAlert(userId, input({ status: "DRAFT", telegramBotId: null }));

    await expect(resumeAlert(userId, alert.id)).rejects.toThrow(/bot/i);

    const withBot = await updateAlert(userId, alert.id, input({ status: "DRAFT", symbol: alert.symbol }));
    expect(withBot.status).toBe("DRAFT");
    const activated = await resumeAlert(userId, alert.id);
    expect(activated.status).toBe("ACTIVE");

    // Fresh activation re-arms with no prior price, so an "above" alert fires on the next tick.
    const r = await tick(alert.symbol, 3950);
    expect(r.triggered.map((x) => x.alertId)).toEqual([alert.id]);
  });

  it("refuses activation while the assigned bot is disabled", async () => {
    const bot = await makeBot(userId, { enabled: false });
    const alert = await createAlert(userId, input({ status: "DRAFT", telegramBotId: bot.id }));
    await expect(resumeAlert(userId, alert.id)).rejects.toThrow(/disabled/i);
    await db.telegramBot.update({ where: { id: bot.id }, data: { enabled: true } });
    expect((await resumeAlert(userId, alert.id)).status).toBe("ACTIVE");
  });

  it("refuses activation when the expiry date has already passed", async () => {
    const alert = await makeAlert(userId, botId, { status: "DRAFT", expiryType: "AT_DATE", expiresAt: new Date(Date.now() - 60_000) });
    await expect(resumeAlert(userId, alert.id)).rejects.toThrow(/expiry/i);
  });

  it("deleting the bot leaves DRAFT alerts as drafts (they are not live)", async () => {
    const { deleteBot } = await import("@/lib/services/bots");
    const bot = await makeBot(userId);
    const draft = await makeAlert(userId, bot.id, { status: "DRAFT" });
    const live = await makeAlert(userId, bot.id, { status: "ACTIVE" });
    const res = await deleteBot(userId, bot.id);
    expect(res.affectedAlerts).toBe(1);
    expect((await db.alert.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
    expect((await db.alert.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("ERROR");
  });
});

describe("COOLDOWN lifecycle in the engine", () => {
  it("a trigger with a cooldown parks the alert in COOLDOWN and it recovers to ACTIVE", async () => {
    const alert = await createAlert(userId, input({ cooldownSeconds: 60, triggerMode: "EVERY_TIME" }));
    const r = await tick(alert.symbol, 3950);
    expect(r.triggered).toHaveLength(1);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("COOLDOWN");

    // Inside the window the alert is loaded but suppressed.
    expect((await tick(alert.symbol, 3951)).triggered).toHaveLength(0);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("COOLDOWN");

    // Move the last trigger back beyond the window: the next tick returns it to ACTIVE and fires again.
    await db.alert.update({ where: { id: alert.id }, data: { lastTriggeredAt: new Date(Date.now() - 61_000) } });
    const after = await tick(alert.symbol, 3952);
    expect(after.triggered).toHaveLength(1);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("COOLDOWN");
  });

  it("a terminal trigger (ONCE) stays TRIGGERED instead of COOLDOWN", async () => {
    const alert = await createAlert(userId, input({ cooldownSeconds: 300, triggerMode: "ONCE" }));
    await tick(alert.symbol, 3950);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("TRIGGERED");
    expect((await tick(alert.symbol, 3951)).triggered).toHaveLength(0);
  });

  it("expireDueAlerts also expires COOLDOWN alerts whose date has passed", async () => {
    const alert = await createAlert(
      userId,
      input({ cooldownSeconds: 3600, expiryType: "AT_DATE", expiresAt: new Date(Date.now() + 30 * 60_000) }),
    );
    await tick(alert.symbol, 3950);
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("COOLDOWN");
    await db.alert.update({ where: { id: alert.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireDueAlerts();
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe("EXPIRED");
  });
});

describe("alert list filters", () => {
  it("the Active filter includes COOLDOWN but never DRAFT", async () => {
    const cooldown = await createAlert(userId, input({ cooldownSeconds: 3600 }));
    const draft = await createAlert(userId, input({ status: "DRAFT" }));
    await tick(cooldown.symbol, 3950);

    const active = await listAlerts(userId, { status: "ACTIVE" });
    expect(active.map((a) => a.id)).toContain(cooldown.id);
    expect(active.map((a) => a.id)).not.toContain(draft.id);
    expect(active.find((a) => a.id === cooldown.id)?.status).toBe("COOLDOWN");

    const drafts = await listAlerts(userId, { status: "DRAFT" });
    expect(drafts.map((a) => a.id)).toContain(draft.id);
    expect(drafts.every((a) => a.status === "DRAFT")).toBe(true);
  });
});

describe("COOLDOWN regressions (review fixes)", () => {
  it("editing an alert in COOLDOWN keeps its trigger budget and cooldown", async () => {
    const a = await createAlert(userId, input({ cooldownSeconds: 3600, expiryType: "AFTER_N_TRIGGERS", maxTriggers: 3 }));
    await tick(a.symbol, 3950);
    const before = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(before.status).toBe("COOLDOWN");
    expect(before.triggerCount).toBe(1);

    await updateAlert(
      userId,
      a.id,
      input({ name: "Renamed", symbol: a.symbol, cooldownSeconds: 3600, expiryType: "AFTER_N_TRIGGERS", maxTriggers: 3 }),
    );
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.name).toBe("Renamed");
    expect(after.status).toBe("COOLDOWN");
    expect(after.triggerCount).toBe(1); // was reset to 0 before the fix
    expect(after.lastTriggeredAt?.getTime()).toBe(before.lastTriggeredAt?.getTime());
  });

  it("the poll-cycle sweep releases finished cooldowns even with no new prices", async () => {
    const { releaseFinishedCooldowns } = await import("@/lib/engine/engine");
    const a = await makeAlert(userId, botId, {
      status: "COOLDOWN",
      cooldownSeconds: 60,
      lastTriggeredAt: new Date(Date.now() - 120_000),
    });
    const stillCooling = await makeAlert(userId, botId, {
      status: "COOLDOWN",
      cooldownSeconds: 3600,
      lastTriggeredAt: new Date(Date.now() - 60_000),
    });
    expect(await releaseFinishedCooldowns()).toBeGreaterThanOrEqual(1);
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ACTIVE");
    expect((await db.alert.findUniqueOrThrow({ where: { id: stillCooling.id } })).status).toBe("COOLDOWN");
  });
});
