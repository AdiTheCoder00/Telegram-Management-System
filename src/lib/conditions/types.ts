import { z } from "zod";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/timeframes";
import { CANDLE_PATTERNS } from "@/lib/market/patterns";
import { BUILTIN_SESSIONS } from "@/lib/market/sessions";
import { getIndicator, resolveParams } from "@/lib/indicators/registry";

/**
 * Condition tree (AST). Stored as JSON on the alert version; validated by `conditionSchema` + `validateTree`.
 *
 *   group   — AND / OR of children
 *   not     — negation
 *   compare — left <op> right, where operands are price fields, indicators (any timeframe) or constants
 *   pattern — candle / volume pattern on a timeframe
 *   session — the evaluated bar is inside a trading session
 *
 * Every node carries an `id` so evaluation results (trigger evidence) can be matched back to the tree.
 */
export const EVALUATION_ENGINE_VERSION = "1.0.0";

const tf = z.enum(TIMEFRAMES);
const id = z.string().min(1).max(40);

const priceField = z.enum(["open", "high", "low", "close"]);

export const operandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("price"),
    field: priceField.default("close"),
    timeframe: tf.optional(),
    multiplier: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal("indicator"),
    indicator: z.string().min(1).max(40),
    params: z.record(z.string(), z.number()).default({}),
    output: z.string().max(20).optional(),
    timeframe: tf.optional(),
    multiplier: z.number().positive().optional(),
  }),
  z.object({ kind: z.literal("value"), value: z.number().finite() }),
]);
export type Operand = z.infer<typeof operandSchema>;

export const COMPARATORS = [">", ">=", "<", "<=", "==", "crosses_above", "crosses_below"] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const COMPARATOR_LABELS: Record<Comparator, string> = {
  ">": "is above",
  ">=": "is at or above",
  "<": "is below",
  "<=": "is at or below",
  "==": "equals",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

const sessionSchema = z.union([
  z.enum(BUILTIN_SESSIONS),
  z.object({
    name: z.string().min(1).max(40),
    timezone: z.string().min(1).max(64),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  }),
]);

export type ConditionNode =
  | { id: string; type: "group"; op: "AND" | "OR"; children: ConditionNode[] }
  | { id: string; type: "not"; child: ConditionNode }
  | { id: string; type: "compare"; left: Operand; op: Comparator; right: Operand; tolerance?: number }
  | {
      id: string;
      type: "pattern";
      pattern: (typeof CANDLE_PATTERNS)[number];
      timeframe?: Timeframe;
      bars?: number;
      dojiMaxBodyPct?: number;
    }
  | { id: string; type: "session"; session: z.infer<typeof sessionSchema> };

export const conditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ id, type: z.literal("group"), op: z.enum(["AND", "OR"]), children: z.array(conditionSchema).min(1).max(20) }),
    z.object({ id, type: z.literal("not"), child: conditionSchema }),
    z.object({
      id,
      type: z.literal("compare"),
      left: operandSchema,
      op: z.enum(COMPARATORS),
      right: operandSchema,
      tolerance: z.number().min(0).optional(),
    }),
    z.object({
      id,
      type: z.literal("pattern"),
      pattern: z.enum(CANDLE_PATTERNS),
      timeframe: tf.optional(),
      bars: z.number().int().min(2).max(50).optional(),
      dojiMaxBodyPct: z.number().min(0).max(50).optional(),
    }),
    z.object({ id, type: z.literal("session"), session: sessionSchema }),
  ]),
) as z.ZodType<ConditionNode>;

export interface TreeLimits {
  maxNodes: number;
  maxDepth: number;
}

/**
 * Semantic validation beyond the schema: known indicators/outputs, parameter ranges, unique node ids,
 * size limits, and that crossings compare series (not two constants). Returns a list of readable problems.
 */
export function validateTree(root: ConditionNode, limits: TreeLimits = { maxNodes: 50, maxDepth: 6 }): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  let count = 0;
  const visit = (n: ConditionNode, depth: number) => {
    count++;
    if (depth > limits.maxDepth) problems.push(`Conditions are nested too deeply (max ${limits.maxDepth}).`);
    if (ids.has(n.id)) problems.push(`Duplicate condition id "${n.id}".`);
    ids.add(n.id);
    if (n.type === "group") n.children.forEach((c) => visit(c, depth + 1));
    else if (n.type === "not") visit(n.child, depth + 1);
    else if (n.type === "compare") {
      for (const o of [n.left, n.right]) {
        if (o.kind !== "indicator") continue;
        const def = getIndicator(o.indicator);
        if (!def) {
          problems.push(`Unknown indicator "${o.indicator}".`);
          continue;
        }
        try {
          resolveParams(def, o.params);
        } catch (err) {
          problems.push((err as Error).message);
        }
        if (o.output && !def.outputs.includes(o.output))
          problems.push(`${def.label} has no output "${o.output}" (use ${def.outputs.join(", ")}).`);
      }
      if ((n.op === "crosses_above" || n.op === "crosses_below") && n.left.kind === "value" && n.right.kind === "value")
        problems.push("A crossing needs at least one moving value (price or an indicator).");
      if (n.left.kind === "value" && n.right.kind === "value") problems.push("Comparing two fixed numbers is always true or always false.");
    }
  };
  visit(root, 1);
  if (count > limits.maxNodes) problems.push(`Too many conditions (max ${limits.maxNodes}).`);
  return [...new Set(problems)];
}

/** All timeframes the tree reads, plus the base timeframe (which operands without a timeframe use). */
export function timeframesUsed(root: ConditionNode, base: Timeframe): Timeframe[] {
  const set = new Set<Timeframe>([base]);
  const visit = (n: ConditionNode) => {
    if (n.type === "group") {
      n.children.forEach(visit);
    } else if (n.type === "not") {
      visit(n.child);
    } else if (n.type === "compare") {
      for (const o of [n.left, n.right]) {
        if (o.kind !== "value" && o.timeframe) set.add(o.timeframe);
      }
    } else if (n.type === "pattern" && n.timeframe) {
      set.add(n.timeframe);
    }
  };
  visit(root);
  return [...set];
}

export function treeNeedsVolume(root: ConditionNode): boolean {
  let needs = false;
  const visit = (n: ConditionNode) => {
    if (n.type === "group") {
      n.children.forEach(visit);
    } else if (n.type === "not") {
      visit(n.child);
    } else if (n.type === "compare") {
      for (const o of [n.left, n.right]) {
        if (o.kind === "indicator" && getIndicator(o.indicator)?.needsVolume) needs = true;
      }
    } else if (n.type === "pattern" && (n.pattern === "volume_increasing" || n.pattern === "volume_decreasing")) {
      needs = true;
    }
  };
  visit(root);
  return needs;
}
