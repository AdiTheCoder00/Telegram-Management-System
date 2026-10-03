import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { debugConditions } from "@/lib/services/debugger";
import type { ConditionNode } from "@/lib/conditions/types";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";

let userId: string;
let botId: string;

const TREE: ConditionNode = {
  id: "g",
  type: "group",
  op: "AND",
  children: [
    {
      id: "a",
      type: "compare",
      left: { kind: "indicator", indicator: "rsi", params: { period: 14 } },
      op: ">=",
      right: { kind: "value", value: 0 },
    },
    { id: "b", type: "compare", left: { kind: "price", field: "close" }, op: ">", right: { kind: "value", value: 1 } },
  ],
};

beforeAll(async () => {
  userId = (await makeUser()).id;
  botId = (await makeBot(userId)).id;
});

afterAll(async () => {
  await disconnectDb();
});

describe("condition debugger (dry run of the live path)", () => {
  it("evaluates an alert on the deterministic mock provider and writes nothing", async () => {
    const a = await makeAlert(userId, botId, {
      symbol: "XAUUSD",
      dataProvider: "mock",
      kind: "CONDITIONS",
      timeframe: "5m",
      evaluationMode: "CANDLE_CLOSE",
      conditionTree: TREE as object,
      triggerMode: "EVERY_TIME",
      status: "ACTIVE",
    });
    const before = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    const r = await debugConditions(userId, { alertId: a.id });
    expect(r.evaluation?.result).toBe(true);
    expect(r.decision?.trigger).toBe(true);
    expect(r.decision?.reason).toBe("triggered");
    expect(r.data[0]).toMatchObject({ timeframe: "5m", source: "synthetic" });
    // CANDLE_CLOSE: evaluated at the close of the last closed bar, never on the forming one.
    expect(r.evaluation?.baseCandle?.state).toBe("CLOSED");

    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.version).toBe(before.version);
    expect(await db.alertEvent.count({ where: { alertId: a.id } })).toBe(0);
    expect(await db.triggerEvidence.count({ where: { alertId: a.id } })).toBe(0);
  });

  it("explains why a live alert would not fire (paused)", async () => {
    const a = await makeAlert(userId, botId, {
      symbol: "XAUUSD",
      dataProvider: "mock",
      kind: "CONDITIONS",
      timeframe: "5m",
      conditionTree: TREE as object,
      status: "PAUSED",
    });
    const r = await debugConditions(userId, { alertId: a.id });
    expect(r.decision?.trigger).toBe(false);
    expect(r.decision?.text).toMatch(/not active/);
  });

  it("evaluates an unsaved configuration at a past instant without look-ahead", async () => {
    const asOf = new Date(Date.UTC(2026, 8, 1, 12, 2, 30));
    const r = await debugConditions(userId, {
      config: { symbol: "XAUUSD", dataProvider: "mock", timeframe: "5m", evaluationMode: "CANDLE_CLOSE", conditionTree: TREE },
      asOf,
    });
    expect(r.evaluatedAt).toBe("2026-09-01T12:00:00.000Z"); // close of the 11:55 bar
    expect(new Date(r.windows["5m"]!.to).getTime()).toBeLessThanOrEqual(asOf.getTime());
    expect(r.decision).toBeNull(); // no alert state to run the state machine on
  });

  it("reports insufficient history instead of guessing", async () => {
    const tree: ConditionNode = {
      id: "x",
      type: "compare",
      left: { kind: "indicator", indicator: "ema", params: { period: 50 } },
      op: ">",
      right: { kind: "value", value: 0 },
    };
    const r = await debugConditions(userId, {
      config: { symbol: "NOHIST", dataProvider: "webhook", timeframe: "5m", evaluationMode: "CANDLE_CLOSE", conditionTree: tree },
    });
    expect(r.evaluation).toBeNull();
    expect(r.blocked).toMatch(/no data/);
  });

  it("refuses other users' alerts and price alerts", async () => {
    const other = await makeUser();
    const a = await makeAlert(other.id, null, { kind: "CONDITIONS", conditionTree: TREE as object, dataProvider: "mock" });
    await expect(debugConditions(userId, { alertId: a.id })).rejects.toThrow(/not found/i);
    const p = await makeAlert(userId, botId);
    await expect(debugConditions(userId, { alertId: p.id })).rejects.toThrow(/indicator-condition/);
  });
});
