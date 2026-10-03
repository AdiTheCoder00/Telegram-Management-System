import { afterAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { getAnalytics } from "@/lib/services/analytics";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

afterAll(async () => {
  await disconnectDb();
});

describe("analytics", () => {
  it("counts real triggers per day/hour in the user's timezone and computes delivery stats", async () => {
    const u = await makeUser();
    const bot = await makeBot(u.id);
    const a = await makeAlert(u.id, bot.id, { name: "Noisy" });
    const now = Date.now();
    const mk = async (t: number, status: "SENT" | "FAILED", isTest = false) => {
      const e = await db.alertEvent.create({
        data: {
          alertId: a.id,
          userId: u.id,
          alertName: a.name,
          symbol: a.symbol,
          conditionType: "PRICE_ABOVE",
          triggerPrice: 1,
          targetPrice: 1,
          triggeredAt: new Date(t),
          isTest,
        },
      });
      await db.telegramDelivery.create({
        data: {
          userId: u.id,
          alertId: a.id,
          alertEventId: e.id,
          telegramBotId: bot.id,
          chatId: "1",
          message: "m",
          status,
          isTest,
          sentAt: status === "SENT" ? new Date(t + 500) : null,
          createdAt: new Date(t),
        },
      });
    };
    await mk(now - 3_600_000, "SENT");
    await mk(now - 7_200_000, "SENT");
    await mk(now - 2 * 86_400_000, "FAILED");
    await mk(now - 1_000, "SENT", true); // tests never count

    const r = await getAnalytics(u.id, "Asia/Kolkata", 30);
    expect(r.totals.triggers).toBe(3);
    expect(r.perDay).toHaveLength(30);
    expect(r.perDay.reduce((s, d) => s + d.n, 0)).toBe(3);
    expect(r.perHour.reduce((s, h) => s + h.n, 0)).toBe(3);
    expect(r.byAlert[0]).toMatchObject({ alertId: a.id, n: 3 });
    expect(r.delivery.successRate).toBeCloseTo(66.7, 1);
    expect(r.delivery.latencyMs.p50).toBeCloseTo(500, -1);
  });
});
