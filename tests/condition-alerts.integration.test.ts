import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import { alertInputSchema } from "@/lib/validation";
import { conditionProblems, createAlert, listAlertVersions, pauseAlert, resumeAlert, updateAlert } from "@/lib/services/alerts";
import type { ConditionNode } from "@/lib/conditions/types";
import { makeBot, makeUser } from "./helpers/fixtures";

let userId: string;
let botId: string;

const RSI_ABOVE_60: ConditionNode = {
  id: "c1",
  type: "compare",
  left: { kind: "indicator", indicator: "rsi", params: { period: 14 } },
  op: ">",
  right: { kind: "value", value: 60 },
};

const input = (over: Record<string, unknown> = {}) =>
  alertInputSchema.parse({
    name: "RSI breakout",
    symbol: "XAUUSD",
    dataProvider: "mock",
    kind: "CONDITIONS",
    timeframe: "5m",
    evaluationMode: "CANDLE_CLOSE",
    conditionTree: RSI_ABOVE_60,
    telegramBotId: botId,
    messageTemplate: DEFAULT_TEMPLATE,
    cooldownSeconds: 0,
    status: "ACTIVE",
    ...over,
  });

beforeAll(async () => {
  userId = (await makeUser()).id;
  botId = (await makeBot(userId)).id;
});

afterAll(async () => {
  await disconnectDb();
});

describe("condition alerts: validation", () => {
  it("does not require a target price, but requires a valid tree", () => {
    expect(() => input()).not.toThrow();
    expect(() => input({ conditionTree: undefined })).toThrow();
    expect(() => input({ conditionTree: { id: "x", type: "compare" } })).toThrow();
    // A price alert still needs its target.
    expect(() => input({ kind: "PRICE", conditionTree: undefined })).toThrow(/target/i);
  });

  it("rejects unknown indicators, bad params and two constants", () => {
    const bad = (t: unknown) => conditionProblems(t, "mock", "5m");
    expect(bad({ ...RSI_ABOVE_60, left: { kind: "indicator", indicator: "nope", params: {} } })[0]).toMatch(/unknown indicator/i);
    expect(bad({ ...RSI_ABOVE_60, left: { kind: "indicator", indicator: "rsi", params: { period: 0 } } }).length).toBeGreaterThan(0);
    expect(bad({ ...RSI_ABOVE_60, left: { kind: "value", value: 1 } })[0]).toMatch(/fixed numbers/i);
    expect(bad(RSI_ABOVE_60)).toEqual([]);
  });

  it("accepts timeframes a provider can only serve by aggregation (Twelve Data 3m ← 1m)", () => {
    const p = conditionProblems({ ...RSI_ABOVE_60, left: { ...RSI_ABOVE_60.left, timeframe: "3m" } } as ConditionNode, "twelvedata", "5m");
    expect(p).toEqual([]);
  });

  it("rejects volume conditions on a provider without volume", async () => {
    const { getProvider } = await import("@/lib/market-data/registry");
    const p = getProvider("mock")!;
    const original = p.capabilities.volume;
    (p.capabilities as { volume: string }).volume = "UNAVAILABLE";
    try {
      const tree: ConditionNode = { id: "v", type: "pattern", pattern: "volume_increasing" };
      expect(conditionProblems(tree, "mock", "5m").join(" ")).toMatch(/volume/i);
    } finally {
      (p.capabilities as { volume: string }).volume = original;
    }
  });

  it("the service refuses to save an invalid tree with a readable error", async () => {
    await expect(
      createAlert(userId, input({ conditionTree: { ...RSI_ABOVE_60, left: { kind: "indicator", indicator: "nope", params: {} } } })),
    ).rejects.toThrow(/unknown indicator/i);
  });
});

describe("condition alerts: versioning", () => {
  it("creates version 1 on create and a new immutable version only when the configuration changes", async () => {
    const a = await createAlert(userId, input());
    expect(a.kind).toBe("CONDITIONS");
    expect(a.configVersion).toBe(1);
    expect((await listAlertVersions(userId, a.id)).map((v) => v.version)).toEqual([1]);

    // Same config saved again → no new version.
    const same = await updateAlert(userId, a.id, input());
    expect(same.configVersion).toBe(1);

    // Pause/resume are state, not configuration.
    await pauseAlert(userId, a.id);
    const resumed = await resumeAlert(userId, a.id);
    expect(resumed.configVersion).toBe(1);

    const changed = await updateAlert(userId, a.id, input({ conditionTree: { ...RSI_ABOVE_60, right: { kind: "value", value: 70 } } }));
    expect(changed.configVersion).toBe(2);
    const versions = await listAlertVersions(userId, a.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    const v1 = versions[1].config as { conditionTree: ConditionNode };
    expect(v1.conditionTree).toEqual(RSI_ABOVE_60); // old version untouched
  });

  it("changing the conditions resets the candle cursor so the new tree starts cleanly", async () => {
    const a = await createAlert(userId, input());
    await db.alert.update({ where: { id: a.id }, data: { lastEvaluatedCandle: new Date(), marketDataState: "FRESH" } });
    await updateAlert(userId, a.id, input({ timeframe: "15m" }));
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.lastEvaluatedCandle).toBeNull();
    expect(after.marketDataState).toBeNull();
  });
});
