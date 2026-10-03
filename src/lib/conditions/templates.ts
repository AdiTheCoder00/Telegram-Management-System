import type { ConditionNode, Operand } from "@/lib/conditions/types";
import type { Timeframe } from "@/lib/market/timeframes";

/**
 * Ready-made condition trees (M18 templates). They are plain starting points — every one is validated and can
 * be edited like any hand-built tree. Indicator choices are conventional defaults, not recommendations.
 */
export interface ConditionTemplate {
  key: string;
  label: string;
  description: string;
  timeframe: Timeframe;
  tree: ConditionNode;
}

const ind = (indicator: string, params: Record<string, number>, extra: { output?: string; timeframe?: Timeframe } = {}): Operand => ({
  kind: "indicator",
  indicator,
  params,
  ...extra,
});
const val = (value: number) => ({ kind: "value" as const, value });
const close: Operand = { kind: "price", field: "close" };

export const CONDITION_TEMPLATES: ConditionTemplate[] = [
  {
    key: "rsi_oversold",
    label: "RSI oversold bounce",
    description: "RSI(14) crosses back above 30.",
    timeframe: "15m",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [{ id: "t1", type: "compare", left: ind("rsi", { period: 14 }), op: "crosses_above", right: val(30) }],
    },
  },
  {
    key: "rsi_overbought",
    label: "RSI overbought",
    description: "RSI(14) crosses below 70.",
    timeframe: "15m",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [{ id: "t1", type: "compare", left: ind("rsi", { period: 14 }), op: "crosses_below", right: val(70) }],
    },
  },
  {
    key: "ema_cross_trend",
    label: "EMA cross with higher-timeframe trend",
    description: "EMA(9) crosses above EMA(21), while price is above EMA(50) on 1h.",
    timeframe: "15m",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "t1", type: "compare", left: ind("ema", { period: 9 }), op: "crosses_above", right: ind("ema", { period: 21 }) },
        {
          id: "t2",
          type: "compare",
          left: { kind: "price", field: "close", timeframe: "1h" },
          op: ">",
          right: ind("ema", { period: 50 }, { timeframe: "1h" }),
        },
      ],
    },
  },
  {
    key: "bb_breakout",
    label: "Bollinger Band breakout",
    description: "Close crosses above the upper Bollinger Band (20, 2).",
    timeframe: "1h",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        {
          id: "t1",
          type: "compare",
          left: close,
          op: "crosses_above",
          right: ind("bbands", { period: 20, stddev: 2 }, { output: "upper" }),
        },
      ],
    },
  },
  {
    key: "macd_cross",
    label: "MACD bullish cross",
    description: "MACD line crosses above its signal line.",
    timeframe: "1h",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        {
          id: "t1",
          type: "compare",
          left: ind("macd", { fast: 12, slow: 26, signal: 9 }, { output: "macd" }),
          op: "crosses_above",
          right: ind("macd", { fast: 12, slow: 26, signal: 9 }, { output: "signal" }),
        },
      ],
    },
  },
  {
    key: "engulfing_london",
    label: "Bullish engulfing in London",
    description: "A bullish engulfing candle during the London session.",
    timeframe: "15m",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "t1", type: "pattern", pattern: "bullish_engulfing" },
        { id: "t2", type: "session", session: "LONDON" },
      ],
    },
  },
  {
    key: "volume_spike",
    label: "Volume spike on an up candle",
    description: "Relative volume above 2 on a bullish candle (needs a feed with volume).",
    timeframe: "5m",
    tree: {
      id: "root",
      type: "group",
      op: "AND",
      children: [
        { id: "t1", type: "compare", left: ind("rvol", { period: 20 }), op: ">", right: val(2) },
        { id: "t2", type: "pattern", pattern: "bullish" },
      ],
    },
  },
];
