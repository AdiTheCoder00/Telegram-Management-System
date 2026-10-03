import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, disconnectDb } from "@/lib/db";
import { evaluateConditionAlert, MAX_CATCHUP_BARS } from "@/lib/engine/condition-engine";
import { processDelivery } from "@/lib/notifications/delivery";
import { computeFreshness } from "@/lib/market/freshness";
import { normalizeCandles } from "@/lib/market/candles";
import { getSeries, type SeriesRequest, type SeriesResult } from "@/lib/market/service";
import type { ConditionNode } from "@/lib/conditions/types";
import { buildWindowContext, lookbackBars } from "@/lib/conditions/window";
import { evaluateConditions } from "@/lib/conditions/evaluate";
import { mockCandle } from "@/lib/market-data/providers/simulated";
import { bucketStart, type Timeframe } from "@/lib/market/timeframes";
import { startMockTelegram, type MockTelegram } from "./helpers/mock-telegram";
import { makeAlert, makeBot, makeUser } from "./helpers/fixtures";
import { candlesFromCloses } from "./helpers/candles";

let tg: MockTelegram;
let userId: string;
let botId: string;

const START = Date.UTC(2026, 9, 5, 0, 0);
const M5 = 300_000;

/** close > 100 on the base timeframe */
const ABOVE_100: ConditionNode = {
  id: "root",
  type: "compare",
  left: { kind: "price", field: "close" },
  op: ">",
  right: { kind: "value", value: 100 },
};

/** A fetchSeries over a fixed in-memory candle list (respecting asOf, so no look-ahead). */
function fixedSeries(candles: ReturnType<typeof candlesFromCloses>) {
  return async (req: SeriesRequest): Promise<SeriesResult> => {
    const visible = candles.filter((c) => c.openTime <= req.asOf);
    const { candles: norm, issues } = normalizeCandles(visible, req.timeframe, req.asOf);
    return {
      candles: norm,
      issues,
      freshness: computeFreshness(norm, req.timeframe, req.asOf, issues),
      source: "provider",
      provider: req.provider,
      fetchedAt: new Date().toISOString(),
    };
  };
}

async function load(id: string) {
  return db.alert.findUniqueOrThrow({ where: { id }, include: { bot: true, user: { select: { timezone: true } } } });
}

async function conditionAlert(over: Parameters<typeof makeAlert>[2] = {}) {
  return makeAlert(userId, botId, {
    kind: "CONDITIONS",
    dataProvider: "mock",
    timeframe: "5m",
    evaluationMode: "CANDLE_CLOSE",
    conditionTree: ABOVE_100 as object,
    triggerMode: "EVERY_TIME",
    status: "ACTIVE",
    ...over,
  });
}

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
  tg.mode = "ok";
});

describe("condition engine (live, against Postgres)", () => {
  it("triggers on a closed candle with evidence, and never twice for the same candle", async () => {
    const candles = candlesFromCloses([99, 99, 99, 101], "5m", START);
    const a = await conditionAlert();
    const now = new Date(START + 4 * M5 + 5_000); // 5s after the 4th bar closed
    const fetch = fixedSeries(candles);

    const r1 = await evaluateConditionAlert(await load(a.id), now, fetch);
    expect(r1.triggered).toHaveLength(1);
    await processDelivery(r1.triggered[0].deliveryId!);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain(a.symbol);

    const ev = await db.triggerEvidence.findFirstOrThrow({ where: { alertId: a.id } });
    expect(ev.candleOpenTime?.getTime()).toBe(START + 3 * M5);
    expect(ev.candleState).toBe("CLOSED");
    expect(ev.price).toBe(101);
    expect(ev.timeframe).toBe("5m");
    expect(ev.evaluationEngineVersion).toBeTruthy();

    // Same instant again (worker restart / second worker): nothing new.
    const r2 = await evaluateConditionAlert(await load(a.id), now, fetch);
    expect(r2.triggered).toHaveLength(0);

    // Even with lastEvaluatedCandle rolled back, the idempotency key blocks a duplicate.
    await db.alert.update({ where: { id: a.id }, data: { lastEvaluatedCandle: null } });
    const r3 = await evaluateConditionAlert(await load(a.id), now, fetch);
    expect(r3.triggered).toHaveLength(0);
    expect(await db.alertEvent.count({ where: { alertId: a.id } })).toBe(1);
  });

  it("does not evaluate the forming candle in CANDLE_CLOSE mode (no look-ahead)", async () => {
    // Bar 3 is still forming at `now` and is above 100, closed bars are not.
    const candles = candlesFromCloses([99, 99, 99, 105], "5m", START);
    const a = await conditionAlert();
    const now = new Date(START + 3 * M5 + 60_000);
    const r = await evaluateConditionAlert(await load(a.id), now, fixedSeries(candles));
    expect(r.triggered).toHaveLength(0);
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.lastEvaluatedCandle?.getTime()).toBe(START + 2 * M5);
  });

  it("catches up at most MAX_CATCHUP_BARS missed candles, each evaluated at its own close", async () => {
    const closes = [99, 99, 99, 101, 101, 101, 101, 101, 101];
    const candles = candlesFromCloses(closes, "5m", START);
    const a = await conditionAlert({ lastEvaluatedCandle: new Date(START + 2 * M5) });
    const now = new Date(START + closes.length * M5 + 1_000);
    const r = await evaluateConditionAlert(await load(a.id), now, fixedSeries(candles));
    expect(r.triggered).toHaveLength(MAX_CATCHUP_BARS);
    const ev = await db.triggerEvidence.findMany({ where: { alertId: a.id }, orderBy: { candleOpenTime: "asc" } });
    expect(ev.map((e) => e.candleOpenTime!.getTime())).toEqual([6, 7, 8].map((i) => START + i * M5));
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.lastEvaluatedCandle?.getTime()).toBe(START + 8 * M5);
  });

  it("stale data never triggers and records why the alert is waiting", async () => {
    const candles = candlesFromCloses([101, 101, 101, 101], "5m", START);
    const a = await conditionAlert();
    const now = new Date(START + 20 * M5); // last candle is long overdue
    const r = await evaluateConditionAlert(await load(a.id), now, fixedSeries(candles));
    expect(r.triggered).toHaveLength(0);
    expect(r.waiting).toBe("STALE");
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.marketDataState).toBe("STALE");
    expect(after.lastEvaluationNote).toMatch(/stale/i);
  });

  it("reports INSUFFICIENT_HISTORY instead of guessing indicator values", async () => {
    const tree: ConditionNode = {
      id: "r",
      type: "compare",
      left: { kind: "indicator", indicator: "rsi", params: { period: 14 } },
      op: ">",
      right: { kind: "value", value: 50 },
    };
    const candles = candlesFromCloses([100, 101, 102, 103, 104], "5m", START);
    const a = await conditionAlert({ conditionTree: tree as object });
    const now = new Date(START + 5 * M5 + 1_000);
    const r = await evaluateConditionAlert(await load(a.id), now, fixedSeries(candles));
    expect(r.triggered).toHaveLength(0);
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.marketDataState).toBe("INSUFFICIENT_HISTORY");
  });

  it("an invalid stored tree puts the alert in an explained ERROR wait, not a crash", async () => {
    const a = await conditionAlert({ conditionTree: { nope: true } });
    const r = await evaluateConditionAlert(await load(a.id), new Date(START + 10 * M5), fixedSeries([]));
    expect(r.waiting).toBe("ERROR");
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).lastEvaluationNote).toMatch(/invalid/i);
  });
});

describe("live == backtest on the deterministic mock provider", () => {
  it("the live engine and an offline replay over the same candles reach the same decision", async () => {
    const tree: ConditionNode = {
      id: "g",
      type: "group",
      op: "AND",
      children: [
        {
          id: "a",
          type: "compare",
          left: { kind: "indicator", indicator: "ema", params: { period: 9 } },
          op: ">",
          right: { kind: "indicator", indicator: "ema", params: { period: 21 } },
        },
        {
          id: "b",
          type: "compare",
          left: { kind: "indicator", indicator: "rsi", params: { period: 14 } },
          op: ">",
          right: { kind: "value", value: 0 },
        },
      ],
    };
    const tf: Timeframe = "5m";
    const symbol = "XAUUSD";
    const asOf = bucketStart(Date.UTC(2026, 8, 20, 12, 7), tf) + 2_000;

    // Live path: market-data service (mock provider) → window → evaluate.
    const lookback = lookbackBars(tree, tf);
    const live = await getSeries({ provider: "mock", symbol, timeframe: tf, asOf, bars: lookback.get(tf)! + 5 });
    expect(live.freshness.state === "FRESH" || live.freshness.state === "LIVE").toBe(true);
    const liveWin = buildWindowContext({
      symbol,
      baseTimeframe: tf,
      mode: "CANDLE_CLOSE",
      asOf,
      tree,
      series: { [tf]: live.candles },
      lookback,
    });

    // Backtest path: a long history including FUTURE candles; the window must cut them off.
    const hist = [];
    for (let t = asOf - 600 * 300_000; t < asOf + 50 * 300_000; t += 300_000) hist.push(mockCandle(symbol, tf, bucketStart(t, tf)));
    const btWin = buildWindowContext({ symbol, baseTimeframe: tf, mode: "CANDLE_CLOSE", asOf, tree, series: { [tf]: hist }, lookback });

    expect(liveWin.insufficient).toEqual([]);
    expect(btWin.insufficient).toEqual([]);
    const l = evaluateConditions(tree, liveWin.ctx!);
    const b = evaluateConditions(tree, btWin.ctx!);
    expect(liveWin.windows).toEqual(btWin.windows);
    expect(l.result).toBe(b.result);
    expect(JSON.stringify(l.tree)).toBe(JSON.stringify(b.tree));
  });
});
