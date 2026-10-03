import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { cancelBacktest, createBacktest, failInterruptedBacktests, getBacktest, runNextBacktest } from "@/lib/services/backtests";
import { datasetHash, runBacktest, type BacktestConfig } from "@/lib/backtest/engine";
import { loadHistory } from "@/lib/backtest/history";
import { evaluateConditionAlert } from "@/lib/engine/condition-engine";
import type { ConditionNode } from "@/lib/conditions/types";
import { mockCandle } from "@/lib/market-data/providers/simulated";
import { bucketStart } from "@/lib/market/timeframes";
import { makeAlert, makeUser } from "./helpers/fixtures";
import { candlesFromCloses } from "./helpers/candles";

let userId: string;

// EMA(9) crosses above EMA(21) on 5m — frequent enough on the mock feed to produce several triggers per day.
const CROSS: ConditionNode = {
  id: "x",
  type: "compare",
  left: { kind: "indicator", indicator: "ema", params: { period: 9 } },
  op: "crosses_above",
  right: { kind: "indicator", indicator: "ema", params: { period: 21 } },
};

const DAY = 86_400_000;
const FROM = Date.UTC(2026, 8, 14, 0, 0); // Monday
const TO = FROM + DAY;

beforeAll(async () => {
  userId = (await makeUser()).id;
});

afterAll(async () => {
  await disconnectDb();
});

const cfg = (over: Partial<BacktestConfig> = {}): BacktestConfig => ({
  symbol: "XAUUSD",
  dataProvider: "mock",
  timeframe: "5m",
  evaluationMode: "CANDLE_CLOSE",
  conditionTree: CROSS,
  triggerMode: "EVERY_TIME",
  cooldownSeconds: 0,
  from: new Date(FROM).toISOString(),
  to: new Date(TO).toISOString(),
  horizons: [1, 5],
  direction: "long",
  ...over,
});

describe("backtest engine (pure)", () => {
  it("no look-ahead: future candles never change past decisions", async () => {
    const closes = [...Array(60)].map((_, i) => 100 + Math.sin(i / 3) * 5);
    const tree: ConditionNode = {
      id: "c",
      type: "compare",
      left: { kind: "price", field: "close" },
      op: "crosses_above",
      right: { kind: "value", value: 100 },
    };
    const start = Date.UTC(2026, 9, 5);
    const c = {
      symbol: "T",
      dataProvider: "mock",
      timeframe: "5m" as const,
      evaluationMode: "CANDLE_CLOSE" as const,
      conditionTree: tree,
      triggerMode: "EVERY_TIME" as const,
      cooldownSeconds: 0,
      horizons: [1],
      direction: "long" as const,
    };
    const a = await runBacktest(
      { ...c, from: new Date(start).toISOString(), to: new Date(start + 40 * 300_000).toISOString() },
      { "5m": candlesFromCloses(closes.slice(0, 40), "5m", start) },
    );
    // Same range, but now the series contains 20 extra future bars that differ wildly.
    const tampered = [...closes.slice(0, 40), ...closes.slice(40).map((x) => x * 3)];
    const b = await runBacktest(
      { ...c, from: new Date(start).toISOString(), to: new Date(start + 40 * 300_000).toISOString() },
      { "5m": candlesFromCloses(tampered, "5m", start) },
    );
    expect(b.triggers.map((t) => t.time)).toEqual(a.triggers.map((t) => t.time));
    expect(a.triggers.length).toBeGreaterThan(0);
  });

  it("cooldown and re-arm come from the shared state machine", async () => {
    const tree: ConditionNode = {
      id: "c",
      type: "compare",
      left: { kind: "price", field: "close" },
      op: ">",
      right: { kind: "value", value: 100 },
    };
    const closes = [99, 101, 101, 101, 99, 101, 101];
    const start = Date.UTC(2026, 9, 5);
    const base = {
      symbol: "T",
      dataProvider: "mock",
      timeframe: "5m" as const,
      evaluationMode: "CANDLE_CLOSE" as const,
      conditionTree: tree,
      cooldownSeconds: 0,
      horizons: [1],
      direction: "long" as const,
      from: new Date(start).toISOString(),
      to: new Date(start + 7 * 300_000).toISOString(),
    };
    const series = { "5m": candlesFromCloses(closes, "5m", start) };
    // Bars 0–1 are warm-up (every window needs 3 bars, live and backtest alike) → 101s at bars 2,3,5,6.
    expect((await runBacktest({ ...base, triggerMode: "EVERY_TIME" }, series)).summary.triggers).toBe(4);
    expect((await runBacktest({ ...base, triggerMode: "REARM" }, series)).summary.triggers).toBe(2);
    expect((await runBacktest({ ...base, triggerMode: "ONCE" }, series)).summary.triggers).toBe(1);
    const cd = await runBacktest({ ...base, triggerMode: "EVERY_TIME", cooldownSeconds: 600 }, series);
    expect(cd.summary.triggers).toBe(2); // bar 2 fires; the 10-min cooldown blocks bar 3; bar 5 fires; bar 6 blocked
    expect(cd.summary.suppressed.cooldown).toBeGreaterThan(0);
  });

  it("dataset hash is stable and sensitive to any candle change", () => {
    const s = { "5m": candlesFromCloses([1, 2, 3], "5m") };
    const t = { "5m": candlesFromCloses([1, 2, 3.0001], "5m") };
    expect(datasetHash(s)).toBe(datasetHash({ "5m": candlesFromCloses([1, 2, 3], "5m") }));
    expect(datasetHash(s)).not.toBe(datasetHash(t));
  });
});

describe("backtest == live (deterministic mock provider)", () => {
  it("the backtest triggers exactly where the live engine, stepped bar by bar, triggers", async () => {
    const from = FROM;
    const to = FROM + 6 * 3_600_000; // 6 hours of 5m bars
    const c = cfg({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), triggerMode: "REARM" });
    const hist = await loadHistory({ provider: "mock", symbol: "XAUUSD", timeframe: "5m", from: from - 3 * DAY, to: to + 3_600_000 });
    expect(hist.issues).toEqual([]);
    const bt = await runBacktest(c, { "5m": hist.candles });

    // Live: a real alert, evaluated by the live condition engine at each bar close (+2s), from fresh mock data.
    const a = await makeAlert(userId, null, {
      symbol: "XAUUSD",
      dataProvider: "mock",
      kind: "CONDITIONS",
      timeframe: "5m",
      evaluationMode: "CANDLE_CLOSE",
      conditionTree: CROSS as object,
      triggerMode: "REARM",
      status: "ACTIVE",
      lastEvaluatedCandle: new Date(bucketStart(from - 1, "5m") - 300_000),
    });
    for (let t = from + 300_000; t <= to; t += 300_000) {
      const alert = await db.alert.findUniqueOrThrow({ where: { id: a.id }, include: { bot: true, user: { select: { timezone: true } } } });
      await evaluateConditionAlert(alert, new Date(t + 2_000));
    }
    const live = await db.triggerEvidence.findMany({ where: { alertId: a.id }, orderBy: { candleOpenTime: "asc" } });
    expect(bt.triggers.length).toBeGreaterThan(0);
    expect(live.map((e) => e.candleOpenTime!.toISOString())).toEqual(bt.triggers.map((t) => t.candleOpenTime));
    expect(live.map((e) => e.price)).toEqual(bt.triggers.map((t) => mockCandle("XAUUSD", "5m", Date.parse(t.candleOpenTime)).close));
  });
});

describe("backtest jobs", () => {
  it("queue → worker → completed, reproducible (same dataset hash, same result)", async () => {
    const one = await createBacktest(userId, {
      ...cfg(),
      from: new Date(FROM),
      to: new Date(FROM + 4 * 3_600_000),
      horizons: [1, 5],
      direction: "long",
      conditionTree: CROSS,
    });
    expect(one.status).toBe("QUEUED");
    while (await runNextBacktest());
    const r1 = await getBacktest(userId, one.id);
    expect(r1.status).toBe("COMPLETED");
    expect(r1.engineVersions).toMatchObject({ backtest: "1.0.0" });
    const ds1 = r1.dataset as { sha256: string; synthetic: boolean };
    expect(ds1.synthetic).toBe(true);

    const two = await createBacktest(userId, {
      ...cfg(),
      from: new Date(FROM),
      to: new Date(FROM + 4 * 3_600_000),
      horizons: [1, 5],
      direction: "long",
      conditionTree: CROSS,
    });
    while (await runNextBacktest());
    const r2 = await getBacktest(userId, two.id);
    expect((r2.dataset as { sha256: string }).sha256).toBe(ds1.sha256);
    expect(r2.triggers).toEqual(r1.triggers);
    expect(r2.summary).toEqual(r1.summary);
  });

  it("validates input and limits", async () => {
    await expect(
      createBacktest(userId, { from: new Date(FROM), to: new Date(FROM - 1), horizons: [1], direction: "long" }),
    ).rejects.toThrow();
    await expect(
      createBacktest(userId, {
        ...cfg(),
        from: new Date(Date.UTC(2020, 0, 1)),
        to: new Date(Date.UTC(2026, 0, 1)),
        horizons: [1],
        direction: "long",
        conditionTree: CROSS,
      }),
    ).rejects.toThrow(/too large/);
    const price = await makeAlert(userId, null);
    await expect(
      createBacktest(userId, { alertId: price.id, from: new Date(FROM), to: new Date(TO), horizons: [1], direction: "long" }),
    ).rejects.toThrow(/indicator-condition/);
  });

  it("can be cancelled while queued; interrupted runs are marked failed", async () => {
    const q = await createBacktest(userId, {
      ...cfg(),
      from: new Date(FROM),
      to: new Date(TO),
      horizons: [1],
      direction: "long",
      conditionTree: CROSS,
    });
    expect((await cancelBacktest(userId, q.id)).status).toBe("CANCELLED");
    const r = await createBacktest(userId, {
      ...cfg(),
      from: new Date(FROM),
      to: new Date(TO),
      horizons: [1],
      direction: "long",
      conditionTree: CROSS,
    });
    await db.backtest.update({ where: { id: r.id }, data: { status: "RUNNING" } });
    expect(await failInterruptedBacktests()).toBeGreaterThanOrEqual(1);
    expect((await getBacktest(userId, r.id)).status).toBe("FAILED");
  });
});
