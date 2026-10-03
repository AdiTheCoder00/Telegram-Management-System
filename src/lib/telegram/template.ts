import { CONDITION_LABELS, TEMPLATE_VARIABLES, type ConditionTypeT, type ParseModeT } from "@/lib/constants";
import { escapeFor, validateMessage, type ValidationIssue } from "@/lib/telegram/format";

export type TemplateVars = Record<(typeof TEMPLATE_VARIABLES)[number]["key"], string>;

const KNOWN = new Set<string>(TEMPLATE_VARIABLES.map((v) => v.key));
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface TemplateContext {
  alertId: string;
  alertName: string;
  symbol: string;
  conditionType: ConditionTypeT;
  targetPrice: number;
  currentPrice: number;
  exchange?: string | null;
  at?: Date;
  timezone?: string;
}

function decimalsFor(n: number) {
  const s = String(n);
  const d = s.includes(".") ? s.split(".")[1].length : 0;
  return Math.min(Math.max(d, Math.abs(n) < 10 ? 4 : 2), 8);
}

export function fmtNumber(n: number, decimals?: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? decimalsFor(n),
    useGrouping: false,
  });
}

export function buildVars(ctx: TemplateContext): TemplateVars {
  const at = ctx.at ?? new Date();
  const tz = ctx.timezone || "UTC";
  const parts = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...opts }).format(at);
  const pct = ctx.targetPrice ? ((ctx.currentPrice - ctx.targetPrice) / ctx.targetPrice) * 100 : 0;
  return {
    symbol: ctx.symbol,
    current_price: fmtNumber(ctx.currentPrice),
    target_price: fmtNumber(ctx.targetPrice),
    condition: CONDITION_LABELS[ctx.conditionType],
    alert_name: ctx.alertName,
    time: parts({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    date: parts({ year: "numeric", month: "2-digit", day: "2-digit" }),
    percentage_distance: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
    exchange: ctx.exchange || "—",
    alert_id: ctx.alertId,
  };
}

/** Replaces {{variables}} with values escaped for the parse mode. Unknown variables are left untouched. */
export function renderTemplate(template: string, vars: Partial<TemplateVars>, mode: ParseModeT): string {
  return template.replace(VAR_RE, (match, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value === undefined ? match : escapeFor(mode, value);
  });
}

export function unknownVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) if (!KNOWN.has(m[1])) found.add(m[1]);
  return [...found];
}

/** Full validation of a template: unknown variables + parse-mode syntax of a sample render. */
export function validateTemplate(template: string, mode: ParseModeT, sample: Partial<TemplateVars>): ValidationIssue[] {
  const issues: ValidationIssue[] = unknownVariables(template).map((v) => ({
    level: "error" as const,
    message: `Unknown variable {{${v}}}.`,
  }));
  return issues.concat(validateMessage(renderTemplate(template, sample, mode), mode));
}

/** Header prepended to test notifications, escaped for the parse mode. */
export function testHeader(mode: ParseModeT): string {
  const title =
    mode === "HTML" ? "<b>🧪 TEST ALERT</b>" : mode === "MARKDOWN" || mode === "MARKDOWN_V2" ? "*🧪 TEST ALERT*" : "🧪 TEST ALERT";
  return `${title}\n${escapeFor(mode, "This is a test notification — the price condition has not been met.")}\n\n`;
}

export const SAMPLE_VARS: TemplateVars = {
  symbol: "XAUUSD",
  current_price: "3901.25",
  target_price: "3900",
  condition: "Price Above",
  alert_name: "Gold Breakout Alert",
  time: "14:35:21",
  date: "2026-10-03",
  percentage_distance: "+0.03%",
  exchange: "OANDA",
  alert_id: "clx0000000000",
};
