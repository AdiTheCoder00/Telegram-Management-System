import { describe, expect, it } from "vitest";
import { conditionSchema, timeframesUsed, treeNeedsVolume, validateTree, type ConditionNode } from "@/lib/conditions/types";
import { EvaluationContext, evaluateConditions } from "@/lib/conditions/evaluate";
import { aggregate, type Candle } from "@/lib/market/candles";
import { candlesFromCloses } from "./helpers/candles";

const T = (iso: string) => Date.parse(iso);
const START = T("2026-10-05T00:00:00Z");

const price = (timeframe?: "5m" | "1h") => ({ kind: "price" as const, field: "close" as const, timeframe });
const value = (v: number) => ({ kind: "value" as const, value: v });
const ind = (indicator: string, params: Record<string, number> = {}, timeframe?: "5m" | "1h", output?: string) => ({
  kind: "indicator" as const,
  indicator,
  params,
  timeframe,
  output,
});

function ctxFor(
  closes: number[],
  asOf: number,
  mode: "CANDLE_CLOSE" | "EVERY_TICK" = "CANDLE_CLOSE",
  extra: Partial<Record<"1h", Candle[]>> = {},
) {
  return new EvaluationContext({
    symbol: "XAUUSD",
    baseTimeframe: "5m",
    mode,
    asOf,
    series: { "5m": candlesFromCloses(closes, "5m", START), ...extra },
  });
}
const endOfBar = (i: number) => START + (i + 1) * 300_000;

describe("schema and semantic validation", () => {
  it("parses a nested tree", () => {
    const tree = {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "a", type: "compare", left: ind("rsi", { period: 14 }), op: "crosses_above", right: value(60) },
        { id: "b", type: "not", child: { id: "c", type: "pattern", pattern: "doji" } },
        { id: "d", type: "session", session: "LONDON" },
      ],
    };
    expect(conditionSchema.safeParse(tree).success).toBe(true);
  });
  it("rejects unknown indicators, bad params, duplicate ids and const-vs-const", () => {
    const tree: ConditionNode = {
      id: "r",
      type: "group",
      op: "OR",
      children: [
        { id: "x", type: "compare", left: ind("nope"), op: ">", right: value(1) },
        { id: "x", type: "compare", left: ind("rsi", { period: 0 }), op: ">", right: value(1) },
        { id: "y", type: "compare", left: value(1), op: ">", right: value(2) },
        { id: "z", type: "compare", left: ind("macd", {}, undefined, "bogus"), op: ">", right: value(0) },
      ],
    };
    const problems = validateTree(tree).join(" | ");
    expect(problems).toMatch(/Unknown indicator "nope"/);
    expect(problems).toMatch(/between/);
    expect(problems).toMatch(/Duplicate condition id/);
    expect(problems).toMatch(/two fixed numbers/);
    expect(problems).toMatch(/no output "bogus"/);
  });
  it("lists the timeframes and volume requirements a tree uses", () => {
    const tree: ConditionNode = {
      id: "r",
      type: "group",
      op: "AND",
      children: [
        { id: "a", type: "compare", left: ind("ema", { period: 50 }, "1h"), op: ">", right: ind("ema", { period: 200 }, "1h") },
        { id: "b", type: "compare", left: ind("rvol"), op: ">", right: value(3) },
      ],
    };
    expect(timeframesUsed(tree, "5m").sort()).toEqual(["1h", "5m"]);
    expect(treeNeedsVolume(tree)).toBe(true);
  });
});

describe("comparisons and crossings", () => {
  const closes = [3895, 3897, 3899, 3901, 3902];
  it("price above a level, with a readable trace", () => {
    const e = evaluateConditions({ id: "a", type: "compare", left: price(), op: ">=", right: value(3900) }, ctxFor(closes, endOfBar(3)));
    expect(e.result).toBe(true);
    expect(e.tree.left).toMatchObject({ label: "Price [5m]", current: 3901, candleState: "CLOSED" });
    expect(e.reason).toBe("All required conditions satisfied.");
  });
  it("crosses above only on the bar where it actually crosses", () => {
    const node: ConditionNode = { id: "x", type: "compare", left: price(), op: "crosses_above", right: value(3900) };
    expect(evaluateConditions(node, ctxFor(closes, endOfBar(3))).result).toBe(true); // 3899 → 3901
    expect(evaluateConditions(node, ctxFor(closes, endOfBar(4))).result).toBe(false); // 3901 → 3902 (already above)
    expect(evaluateConditions(node, ctxFor(closes, endOfBar(2))).result).toBe(false);
  });
  it("crossing boundaries follow ta.crossover: leaving the line crosses, touching it does not", () => {
    const up: ConditionNode = { id: "x", type: "compare", left: price(), op: "crosses_above", right: value(3900) };
    expect(evaluateConditions(up, ctxFor([3900, 3901], endOfBar(1))).result).toBe(true); // on the line → above
    expect(evaluateConditions(up, ctxFor([3899, 3900], endOfBar(1))).result).toBe(false); // touch from below
    const down: ConditionNode = { id: "y", type: "compare", left: price(), op: "crosses_below", right: value(3900) };
    expect(evaluateConditions(down, ctxFor([3900, 3899], endOfBar(1))).result).toBe(true);
    expect(evaluateConditions(down, ctxFor([3901, 3900], endOfBar(1))).result).toBe(false);
  });
  it("detects a jump straight across the level", () => {
    const node: ConditionNode = { id: "x", type: "compare", left: price(), op: "crosses_below", right: value(3900) };
    expect(evaluateConditions(node, ctxFor([3950, 3850], endOfBar(1))).result).toBe(true);
  });
  it("indicator warm-up yields 'cannot evaluate' (not true, not silently false)", () => {
    const e = evaluateConditions(
      { id: "r", type: "compare", left: ind("rsi", { period: 14 }), op: ">", right: value(60) },
      ctxFor(closes, endOfBar(4)),
    );
    expect(e.result).toBe(false);
    expect(e.tree.result).toBeNull();
    expect(e.reason).toMatch(/Cannot evaluate yet/);
  });
  it("missing volume is explained, never substituted", () => {
    const ctx = new EvaluationContext({
      symbol: "EURUSD",
      baseTimeframe: "5m",
      mode: "CANDLE_CLOSE",
      asOf: endOfBar(29),
      series: {
        "5m": candlesFromCloses(
          Array.from({ length: 30 }, (_, i) => 1.17 + i * 0.0001),
          "5m",
          START,
          { volume: () => null },
        ),
      },
    });
    const e = evaluateConditions({ id: "v", type: "compare", left: ind("rvol"), op: ">", right: value(3) }, ctx);
    expect(e.tree.result).toBeNull();
    expect(e.tree.reason).toMatch(/Volume is not available/);
  });
});

describe("boolean logic (AND / OR / NOT with unknowns)", () => {
  const ctx = ctxFor([10, 11, 12], endOfBar(2));
  const T_ = { id: "t", type: "compare", left: price(), op: ">", right: value(1) } as const;
  const F_ = { id: "f", type: "compare", left: price(), op: "<", right: value(1) } as const;
  const U_ = { id: "u", type: "compare", left: ind("rsi", { period: 14 }), op: ">", right: value(1) } as const;
  const g = (op: "AND" | "OR", ...children: ConditionNode[]): ConditionNode => ({ id: `g${op}`, type: "group", op, children });
  it("AND: any false → false, else any unknown → unknown", () => {
    expect(evaluateConditions(g("AND", T_, F_, U_), ctx).tree.result).toBe(false);
    expect(evaluateConditions(g("AND", T_, U_), ctx).tree.result).toBeNull();
    expect(evaluateConditions(g("AND", T_, T_), ctx).tree.result).toBe(true);
  });
  it("OR: any true → true, else any unknown → unknown", () => {
    expect(evaluateConditions(g("OR", F_, U_, T_), ctx).tree.result).toBe(true);
    expect(evaluateConditions(g("OR", F_, U_), ctx).tree.result).toBeNull();
  });
  it("NOT inverts, and keeps unknown unknown", () => {
    expect(evaluateConditions({ id: "n", type: "not", child: F_ }, ctx).result).toBe(true);
    expect(evaluateConditions({ id: "n", type: "not", child: U_ }, ctx).tree.result).toBeNull();
  });
});

describe("candle-close vs every-tick", () => {
  // Bar 3 is still forming at asOf and temporarily satisfies the condition.
  const closes = [3890, 3892, 3895, 3905];
  const asOf = START + 3 * 300_000 + 120_000; // 2 minutes into bar 3
  const node: ConditionNode = { id: "a", type: "compare", left: price(), op: ">", right: value(3900) };
  it("CANDLE_CLOSE ignores the forming candle", () => {
    const e = evaluateConditions(node, ctxFor(closes, asOf, "CANDLE_CLOSE"));
    expect(e.result).toBe(false);
    expect(e.baseCandle?.state).toBe("CLOSED");
    expect(e.baseCandle?.close).toBe(3895);
  });
  it("EVERY_TICK evaluates the forming candle", () => {
    const e = evaluateConditions(node, ctxFor(closes, asOf, "EVERY_TICK"));
    expect(e.result).toBe(true);
    expect(e.baseCandle?.state).toBe("FORMING");
  });
});

describe("multi-timeframe synchronisation (no look-ahead)", () => {
  // 5m candles for 3 hours; 1h candles aggregated from them.
  const closes = Array.from({ length: 36 }, (_, i) => (i < 24 ? 3900 - i : 3800 + (i - 24) * 20));
  const m5 = candlesFromCloses(closes, "5m", START);
  const node: ConditionNode = { id: "h", type: "compare", left: price("1h"), op: ">", right: value(3850) };

  it("uses only the last CLOSED higher-timeframe candle, never the forming one", () => {
    const asOf = START + 2 * 3_600_000 + 50 * 60_000; // 02:50 — third 1h candle (02:00–03:00) is forming
    const h1 = aggregate(
      m5.filter((c) => c.openTime < asOf),
      "5m",
      "1h",
      asOf,
    );
    expect(h1[2].state).toBe("FORMING");
    const ctx = new EvaluationContext({
      symbol: "XAUUSD",
      baseTimeframe: "5m",
      mode: "CANDLE_CLOSE",
      asOf,
      series: { "5m": m5, "1h": h1 },
    });
    const e = evaluateConditions(node, ctx);
    // The forming 02:00 candle has climbed above 3850, but the last closed 1h candle (01:00) closed at 3877.
    expect(e.tree.left?.candleTime).toBe("2026-10-05T01:00:00.000Z");
    expect(e.tree.left?.candleState).toBe("CLOSED");
  });

  it("evaluating at T gives the same answer whether or not later candles exist", () => {
    const asOf = START + 2 * 3_600_000 + 10 * 60_000;
    const full1h = aggregate(m5, "5m", "1h", START + 3 * 3_600_000); // contains the future
    const past1h = aggregate(
      m5.filter((c) => c.openTime < asOf),
      "5m",
      "1h",
      asOf,
    );
    const tree: ConditionNode = {
      id: "r",
      type: "group",
      op: "AND",
      children: [node, { id: "e", type: "compare", left: ind("ema", { period: 2 }, "1h"), op: "<", right: price() }],
    };
    const a = evaluateConditions(
      tree,
      new EvaluationContext({ symbol: "X", baseTimeframe: "5m", mode: "CANDLE_CLOSE", asOf, series: { "5m": m5, "1h": full1h } }),
    );
    const b = evaluateConditions(
      tree,
      new EvaluationContext({
        symbol: "X",
        baseTimeframe: "5m",
        mode: "CANDLE_CLOSE",
        asOf,
        series: { "5m": m5.filter((c) => c.openTime < asOf), "1h": past1h },
      }),
    );
    expect(a.tree).toEqual(b.tree);
  });

  it("supports 1H EMA50 > EMA200 AND 5M RSI crosses above 60", () => {
    const tree: ConditionNode = {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "trend", type: "compare", left: ind("ema", { period: 50 }, "1h"), op: ">", right: ind("ema", { period: 200 }, "1h") },
        { id: "mom", type: "compare", left: ind("rsi", { period: 14 }, "5m"), op: "crosses_above", right: value(60) },
      ],
    };
    const ctx = ctxFor(closes, endOfBar(35));
    const e = evaluateConditions(tree, ctx);
    expect(e.tree.children?.map((c) => c.id)).toEqual(["trend", "mom"]);
    expect(e.tree.children?.[0].result).toBeNull(); // no 1h series supplied → cannot evaluate, not true
  });
});

describe("session condition", () => {
  it("checks the evaluated bar's open time", () => {
    const closes = [1, 2, 3];
    const londonMorning = T("2026-10-05T10:00:00Z"); // 11:00 BST Monday = 19:00 JST (Tokyo closed)
    const ctx = new EvaluationContext({
      symbol: "GBPUSD",
      baseTimeframe: "5m",
      mode: "CANDLE_CLOSE",
      asOf: londonMorning + 3 * 300_000,
      series: { "5m": candlesFromCloses(closes, "5m", londonMorning) },
    });
    expect(evaluateConditions({ id: "s", type: "session", session: "LONDON" }, ctx).result).toBe(true);
    expect(evaluateConditions({ id: "s", type: "session", session: "ASIA" }, ctx).result).toBe(false);
  });
});

describe("re-pointing a context (backtest stepping) equals building a fresh one", () => {
  it("matches bar by bar", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 3900 + Math.sin(i / 4) * 10);
    const tree: ConditionNode = { id: "r", type: "compare", left: ind("rsi", { period: 14 }), op: "crosses_above", right: value(55) };
    const shared = ctxFor(closes, endOfBar(0));
    for (let i = 0; i < 60; i++) {
      shared.setAsOf(endOfBar(i));
      expect(evaluateConditions(tree, shared).tree).toEqual(evaluateConditions(tree, ctxFor(closes.slice(0, i + 1), endOfBar(i))).tree);
    }
  });
});

describe("condition templates", () => {
  it("every template is a valid tree", async () => {
    const { CONDITION_TEMPLATES } = await import("@/lib/conditions/templates");
    const { conditionSchema, validateTree } = await import("@/lib/conditions/types");
    for (const t of CONDITION_TEMPLATES) {
      const parsed = conditionSchema.parse(t.tree);
      expect(validateTree(parsed), t.key).toEqual([]);
    }
  });
});
