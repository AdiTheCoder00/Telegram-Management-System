import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { pauseAll, resumeAll, retryFailedNotifications, systemStatus } from "@/lib/services/operations";
import { pauseAlert } from "@/lib/services/alerts";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let userId: string;
let botId: string;

beforeAll(async () => {
  userId = (await makeUser()).id;
  botId = (await makeBot(userId)).id;
});

afterAll(async () => {
  await disconnectDb();
});

describe("operations", () => {
  it("pause all → resume all restores exactly the alerts that were live, never manually paused ones", async () => {
    const live1 = await makeAlert(userId, botId, { status: "ACTIVE" });
    const live2 = await makeAlert(userId, botId, { status: "COOLDOWN" });
    const manual = await makeAlert(userId, botId, { status: "PAUSED" });

    expect((await pauseAll(userId)).paused).toBe(2);
    const st = await systemStatus(userId);
    expect(st.alerts.pausedByBulk).toBe(2);
    expect(st.alerts.live).toBe(0);

    // The user touches one of them manually in between: it is no longer part of the bulk set.
    await pauseAlert(userId, live2.id);

    const r = await resumeAll(userId);
    expect(r.resumed).toBe(1);
    expect((await db.alert.findUniqueOrThrow({ where: { id: live1.id } })).status).toBe("ACTIVE");
    expect((await db.alert.findUniqueOrThrow({ where: { id: live2.id } })).status).toBe("PAUSED");
    expect((await db.alert.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("PAUSED");
    expect(await db.alert.count({ where: { userId, pausedByBulk: true } })).toBe(0);

    const actions = (await db.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["alerts.pause_all", "alerts.resume_all"]));
  });

  it("retry failed notifications re-queues FAILED and DEAD_LETTER deliveries and is audited", async () => {
    const a = await makeAlert(userId, botId);
    const e = await db.alertEvent.create({
      data: {
        alertId: a.id,
        userId,
        alertName: a.name,
        symbol: a.symbol,
        conditionType: "PRICE_ABOVE",
        triggerPrice: 1,
        targetPrice: 1,
        status: "FAILED",
      },
    });
    await db.telegramDelivery.create({
      data: {
        userId,
        alertId: a.id,
        alertEventId: e.id,
        telegramBotId: botId,
        chatId: "1",
        message: "m",
        status: "DEAD_LETTER",
        attempts: 6,
      },
    });
    const r = await retryFailedNotifications(userId);
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    const d = await db.telegramDelivery.findFirstOrThrow({ where: { alertEventId: e.id } });
    expect(d.status).toBe("QUEUED");
    expect(d.attempts).toBe(0);
    expect(await db.auditLog.count({ where: { userId, action: "notifications.retry_failed" } })).toBe(1);
  });

  it("system status reports providers honestly (mock is synthetic, Twelve Data unconfigured without a key)", async () => {
    const st = await systemStatus(userId);
    expect(st.providers.find((p) => p.key === "mock")?.synthetic).toBe(true);
    if (!process.env.TWELVE_DATA_API_KEY && !process.env.MARKET_DATA_API_KEY)
      expect(st.providers.find((p) => p.key === "twelvedata")?.configured).toBe(false);
    expect(st.queues.mode).toBeTruthy();
  });
});
