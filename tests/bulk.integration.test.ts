import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { bulkAction, createGroup, exportAlerts, importAlerts, importSchema, listGroups } from "@/lib/services/alert-bulk";
import { listAlerts } from "@/lib/services/alerts";
import type { ConditionNode } from "@/lib/conditions/types";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let userId: string;
let botId: string;

const TREE: ConditionNode = {
  id: "root",
  type: "group",
  op: "AND",
  children: [
    {
      id: "a",
      type: "compare",
      left: { kind: "indicator", indicator: "rsi", params: { period: 14 } },
      op: ">",
      right: { kind: "value", value: 60 },
    },
  ],
};

beforeAll(async () => {
  userId = (await makeUser()).id;
  botId = (await makeBot(userId, { name: "Main bot" })).id;
});

afterAll(async () => {
  await disconnectDb();
});

describe("bulk actions", () => {
  it("pauses and resumes many alerts, reporting per-alert failures from the activation gate", async () => {
    const ok = await makeAlert(userId, botId, { status: "ACTIVE" });
    const noBot = await makeAlert(userId, null, { status: "PAUSED" }); // cannot be activated
    const other = await makeAlert((await makeUser()).id, null, { status: "ACTIVE" }); // not ours: ignored

    const p = await bulkAction(userId, { ids: [ok.id, noBot.id, other.id], action: "pause" });
    expect(p.results.map((r) => r.id).sort()).toEqual([ok.id, noBot.id].sort());
    expect((await db.alert.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("ACTIVE");

    const r = await bulkAction(userId, { ids: [ok.id, noBot.id], action: "resume" });
    expect(r.results.find((x) => x.id === ok.id)?.ok).toBe(true);
    const failed = r.results.find((x) => x.id === noBot.id)!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/bot/i);
    expect(await db.auditLog.count({ where: { userId, action: "alerts.bulk_resume" } })).toBe(1);
  });

  it("moves alerts into a group and filters by it", async () => {
    const g = await createGroup(userId, "Gold setups");
    await expect(createGroup(userId, "gold SETUPS")).rejects.toThrow(/exists/);
    const a = await makeAlert(userId, botId);
    await bulkAction(userId, { ids: [a.id], action: "group", groupId: g.id });
    expect((await listAlerts(userId, { groupId: g.id })).map((x) => x.id)).toEqual([a.id]);
    expect((await listGroups(userId)).find((x) => x.id === g.id)?.alerts).toBe(1);
  });
});

describe("JSON export / import", () => {
  it("round-trips alerts (no bot ids or secrets), imports paused, matches bots by name, keeps groups", async () => {
    const u = (await makeUser()).id;
    const bot = await makeBot(u, { name: "Main bot" });
    const g = await createGroup(u, "Swing");
    const c = await makeAlert(u, bot.id, {
      kind: "CONDITIONS",
      dataProvider: "mock",
      symbol: "XAUUSD",
      timeframe: "1h",
      conditionTree: TREE as object,
      status: "ACTIVE",
      groupId: g.id,
      name: "RSI swing",
    });
    await makeAlert(u, bot.id, { name: "Price level", targetPrice: 4000 });

    const file = await exportAlerts(u);
    const text = JSON.stringify(file);
    expect(text).not.toContain(bot.id);
    expect(text).not.toContain("encryptedToken");
    expect(file.alerts).toHaveLength(2);

    const target = (await makeUser()).id;
    await makeBot(target, { name: "Main bot" });
    const r = await importAlerts(target, importSchema.parse(JSON.parse(text)));
    expect(r.imported).toBe(2);
    const imported = await db.alert.findMany({ where: { userId: target }, include: { group: true, bot: true }, orderBy: { name: "asc" } });
    expect(imported.every((a) => a.status === "PAUSED")).toBe(true);
    expect(imported.every((a) => a.bot?.name === "Main bot")).toBe(true);
    const rsi = imported.find((a) => a.name === "RSI swing")!;
    expect(rsi.conditionTree).toEqual(c.conditionTree);
    expect(rsi.group?.name).toBe("Swing");
    expect(await db.alertVersion.count({ where: { alertId: rsi.id } })).toBe(1);
  });

  it("is all-or-nothing: one invalid alert imports nothing", async () => {
    const target = (await makeUser()).id;
    const file = await exportAlerts(userId);
    const bad = { ...file, alerts: [...file.alerts, { ...file.alerts[0], symbol: "bad symbol!" }] };
    await expect(importAlerts(target, importSchema.parse(bad))).rejects.toThrow(/Nothing was imported/);
    expect(await db.alert.count({ where: { userId: target } })).toBe(0);
    expect(() => importSchema.parse({ format: "other", version: 1, alerts: [] })).toThrow();
  });
});
