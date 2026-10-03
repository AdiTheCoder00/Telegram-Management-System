import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { logger, scrubSecrets } from "@/lib/logger";
import { decrypt } from "@/lib/crypto";
import { processPriceTick } from "@/lib/engine/engine";
import { processDelivery } from "@/lib/notifications/delivery";
import { createBot, listBots, sendAdHocTestMessage, sendBotTestMessage, updateBot, verifyBot } from "@/lib/services/bots";
import { createAlert, resumeAlert } from "@/lib/services/alerts";
import { getDashboard } from "@/lib/services/dashboard";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import { MIGRATED_CHAT, startMockTelegram, VALID_TOKEN, type MockTelegram } from "./helpers/mock-telegram";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let tg: MockTelegram;
let userId: string;
let t = Date.parse("2026-10-04T09:00:00Z");
const nextTime = () => new Date((t += 1000));

beforeAll(async () => {
  tg = await startMockTelegram();
  process.env.TELEGRAM_API_URL = tg.url;
  userId = (await makeUser()).id;
});
beforeEach(() => {
  tg.sent.length = 0;
  tg.mode = "ok";
});
afterAll(async () => {
  await tg.close();
  await disconnectDb();
});

describe("enable / disable", () => {
  it("a disabled bot sends nothing, but the trigger is still recorded", async () => {
    const bot = await makeBot(userId);
    const alert = await makeAlert(userId, bot.id);
    await updateBot(userId, bot.id, { enabled: false });

    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: alert.symbol, price: 3950, time: nextTime() });
    expect(r.triggered).toHaveLength(1);
    const out = await processDelivery(r.triggered[0].deliveryId!);
    expect(out.status).toBe("failed");
    expect(tg.sent).toHaveLength(0);

    const event = await db.alertEvent.findUniqueOrThrow({ where: { id: r.triggered[0].eventId } });
    expect(event.status).toBe("FAILED");
    const d = await db.telegramDelivery.findUniqueOrThrow({ where: { id: r.triggered[0].deliveryId! } });
    expect(d.error).toMatch(/disabled/i);
    expect(d.errorDetail).toBe("bot_disabled");
  });

  it("blocks test messages while disabled but still allows a connection check", async () => {
    const bot = await makeBot(userId, { enabled: false });
    await expect(sendBotTestMessage(userId, bot.id)).rejects.toThrow(/disabled/i);
    expect(tg.sent).toHaveLength(0);
    expect((await verifyBot(userId, bot.id)).status).toBe("CONNECTED");
  });

  it("re-enabling resumes delivery", async () => {
    const bot = await makeBot(userId, { enabled: false });
    await updateBot(userId, bot.id, { enabled: true });
    const res = await sendBotTestMessage(userId, bot.id);
    expect(res.status).toBe("sent");
    expect(tg.sent).toHaveLength(1);
  });

  it("an alert cannot be activated or resumed on a disabled bot (it can be saved paused)", async () => {
    const bot = await makeBot(userId, { enabled: false });
    const input = {
      name: "On disabled bot",
      kind: "PRICE" as const,
      timeframe: "5m" as const,
      evaluationMode: "CANDLE_CLOSE" as const,
      symbol: "XAUUSD",
      dataProvider: "webhook",
      conditionType: "PRICE_ABOVE" as const,
      targetPrice: 3900,
      tolerance: 0,
      telegramBotId: bot.id,
      messageTemplate: DEFAULT_TEMPLATE,
      parseMode: "PLAIN" as const,
      triggerMode: "REARM" as const,
      cooldownSeconds: 60,
      expiryType: "NEVER" as const,
    };
    await expect(createAlert(userId, { ...input, status: "ACTIVE" })).rejects.toThrow(/disabled/i);
    const paused = await createAlert(userId, { ...input, status: "PAUSED" });
    expect(paused.status).toBe("PAUSED");
    await expect(resumeAlert(userId, paused.id)).rejects.toThrow(/disabled/i);
  });

  it("disabled bots don't count as connected on the dashboard", async () => {
    const solo = await makeUser();
    await makeBot(solo.id, { enabled: false });
    const d = await getDashboard(solo.id, "UTC");
    expect(d.telegram.status).toBe("DISCONNECTED");
    expect(d.telegram.disabled).toBe(1);
  });
});

describe("add bot", () => {
  it("verifies the connection, encrypts the token at rest and never returns it", async () => {
    const bot = await createBot(userId, { name: "Added bot", token: VALID_TOKEN, chatId: "-1001234567890" });
    expect(bot.status).toBe("CONNECTED");
    expect(bot.botUsername).toBe("test_alerts_bot");
    expect(bot.chatTitle).toBe("Trading Alerts");
    expect(bot.tokenHint).toBe(`••••${VALID_TOKEN.slice(-4)}`);
    expect(JSON.stringify(bot)).not.toContain(VALID_TOKEN);
    const row = await db.telegramBot.findUniqueOrThrow({ where: { id: bot.id } });
    expect(row.encryptedToken).not.toContain(VALID_TOKEN);
    expect(decrypt(row.encryptedToken)).toBe(VALID_TOKEN);
  });

  it("adopts the new chat ID when the saved group already migrated to a supergroup", async () => {
    const bot = await createBot(userId, { name: "Migrated on add", token: VALID_TOKEN, chatId: MIGRATED_CHAT });
    expect(bot.status).toBe("CONNECTED");
    expect(bot.chatId).toBe("-1001234567890");
    expect(bot.lastError).toMatch(/updated automatically/);
  });

  it("saves an unreachable chat as ERROR with a friendly message instead of throwing", async () => {
    const bot = await createBot(userId, { name: "Bad chat", token: VALID_TOKEN, chatId: "400400400" });
    expect(bot.status).toBe("ERROR");
    expect(bot.lastError).toMatch(/could not find that chat/i);
  });

  it("enforces the bot limit", async () => {
    const prev = process.env.MAX_BOTS_PER_USER;
    process.env.MAX_BOTS_PER_USER = "0";
    try {
      await expect(createBot(userId, { name: "Over limit", token: VALID_TOKEN, chatId: "42" })).rejects.toThrow(/up to 0 bots/);
    } finally {
      if (prev === undefined) delete process.env.MAX_BOTS_PER_USER;
      else process.env.MAX_BOTS_PER_USER = prev;
    }
  });
});
describe("group upgraded to supergroup (chat ID migration)", () => {
  it("delivery follows Telegram's new chat ID, updates the bot and records why", async () => {
    const bot = await makeBot(userId, { chatId: MIGRATED_CHAT });
    const alert = await makeAlert(userId, bot.id);
    const r = await processPriceTick({ provider: "webhook", scope: userId, symbol: alert.symbol, price: 3950, time: nextTime() });
    const out = await processDelivery(r.triggered[0].deliveryId!);
    expect(out.status).toBe("sent");
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].chat_id).toBe("-1001234567890");

    expect((await db.telegramBot.findUniqueOrThrow({ where: { id: bot.id } })).chatId).toBe("-1001234567890");
    const d = await db.telegramDelivery.findUniqueOrThrow({ where: { id: r.triggered[0].deliveryId! } });
    expect(d.chatId).toBe("-1001234567890");
    expect(d.error).toMatch(/new Chat ID -1001234567890/);
  });

  it("connection check adopts the new chat ID", async () => {
    const bot = await makeBot(userId, { chatId: MIGRATED_CHAT, status: "ERROR" });
    const v = await verifyBot(userId, bot.id);
    expect(v.status).toBe("CONNECTED");
    expect(v.chatId).toBe("-1001234567890");
    expect(v.lastError).toMatch(/updated automatically/);
  });

  it("the add-bot test returns the new chat ID so the form can save it", async () => {
    const res = await sendAdHocTestMessage(VALID_TOKEN, MIGRATED_CHAT);
    expect(res.status).toBe("sent");
    expect("chatId" in res && res.chatId).toBe("-1001234567890");
  });
});

describe("secret handling", () => {
  it("never returns token material from the bots API layer", async () => {
    await makeBot(userId);
    const json = JSON.stringify(await listBots(userId));
    expect(json).not.toContain(VALID_TOKEN);
    expect(json).not.toContain("encryptedToken");
    expect(json).not.toMatch(/v1:[A-Za-z0-9+/=]+:/); // ciphertext format
  });

  it("scrubs bot tokens from strings, both in URLs and bare", () => {
    expect(scrubSecrets(`https://api.telegram.org/bot${VALID_TOKEN}/sendMessage`)).not.toContain(VALID_TOKEN);
    expect(scrubSecrets(`token was ${VALID_TOKEN} oops`)).toBe("token was [redacted-token] oops");
  });

  it("logger output never contains a token, whether in the message, an error or a meta field", () => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(" "))),
    );
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    logger.error(`failed calling bot${VALID_TOKEN}/getMe`, { err: new Error(`boom ${VALID_TOKEN}`), note: `t=${VALID_TOKEN}`, token: "x" });
    process.env.LOG_LEVEL = prev;
    spies.forEach((s) => s.mockRestore());
    expect(lines.join("\n")).not.toContain(VALID_TOKEN);
    expect(lines.join("\n")).toContain("[redacted]");
  });
});

describe("chat discovery and bot-as-chat guard", () => {
  it("lists chats the bot has seen, newest first, de-duplicated, without consuming updates", async () => {
    const { discoverChats } = await import("@/lib/telegram/client");
    tg.updates = [
      { update_id: 1, message: { date: 100, chat: { id: 42, type: "private", first_name: "Alex", username: "alex" } } },
      { update_id: 2, my_chat_member: { date: 200, chat: { id: -1001234567890, type: "supergroup", title: "Trading Alerts" } } },
      { update_id: 3, message: { date: 300, chat: { id: 42, type: "private", first_name: "Alex", username: "alex" } } },
    ];
    const r = await discoverChats(VALID_TOKEN);
    expect(r.botUsername).toBe("test_alerts_bot");
    expect(r.chats.map((c) => [c.id, c.title, c.type])).toEqual([
      ["42", "@alex", "private"],
      ["-1001234567890", "Trading Alerts", "supergroup"],
    ]);
    tg.updates = [];
  });

  it("explains when a webhook blocks discovery", async () => {
    const { discoverChats } = await import("@/lib/telegram/client");
    tg.webhookSet = true;
    const r = await discoverChats(VALID_TOKEN);
    tg.webhookSet = false;
    expect(r.chats).toEqual([]);
    expect(r.error).toMatch(/webhook/);
  });

  it("rejects the bot's own username as the destination chat (regression: it used to verify as Connected)", async () => {
    const bot = await makeBot(userId, { chatId: "@test_alerts_bot", status: "CONNECTED" });
    const v = await verifyBot(userId, bot.id);
    expect(v.status).toBe("ERROR");
    expect(v.lastError).toMatch(/is a bot/);
  });
});
