/**
 * Shared (client + server) constants. Values mirror the Prisma enums in prisma/schema.prisma.
 */
export const CONDITION_TYPES = ["PRICE_ABOVE", "PRICE_BELOW", "CROSSES_ABOVE", "CROSSES_BELOW", "PRICE_EQUALS"] as const;
export type ConditionTypeT = (typeof CONDITION_TYPES)[number];

export const CONDITION_LABELS: Record<ConditionTypeT, string> = {
  PRICE_ABOVE: "Price Above",
  PRICE_BELOW: "Price Below",
  CROSSES_ABOVE: "Price Crosses Above",
  CROSSES_BELOW: "Price Crosses Below",
  PRICE_EQUALS: "Price Equals",
};

export const CONDITION_SHORT: Record<ConditionTypeT, string> = {
  PRICE_ABOVE: "Above",
  PRICE_BELOW: "Below",
  CROSSES_ABOVE: "Crosses ↑",
  CROSSES_BELOW: "Crosses ↓",
  PRICE_EQUALS: "Equals",
};

export const CONDITION_HELP: Record<ConditionTypeT, string> = {
  PRICE_ABOVE: "Triggers when price is at or above the target (price ≥ target).",
  PRICE_BELOW: "Triggers when price is at or below the target (price ≤ target).",
  CROSSES_ABOVE: "Triggers only when price moves from below the target to at/above it.",
  CROSSES_BELOW: "Triggers only when price moves from above the target to at/below it.",
  PRICE_EQUALS: "Triggers when price is within the tolerance of the target.",
};

export const TRIGGER_MODES = ["ONCE", "EVERY_TIME", "REARM"] as const;
export type TriggerModeT = (typeof TRIGGER_MODES)[number];
export const TRIGGER_MODE_LABELS: Record<TriggerModeT, string> = {
  ONCE: "Once",
  EVERY_TIME: "Every time condition is met",
  REARM: "Re-arm after price returns",
};
export const TRIGGER_MODE_HELP: Record<TriggerModeT, string> = {
  ONCE: "Sends a single notification, then the alert is marked Triggered.",
  EVERY_TIME: "Sends on every price update that meets the condition — the cooldown limits frequency.",
  REARM: "Sends once, then waits until price moves back to the other side of the target before it can fire again.",
};

export const EXPIRY_TYPES = ["NEVER", "AFTER_FIRST_TRIGGER", "AT_DATE", "AFTER_N_TRIGGERS"] as const;
export type ExpiryTypeT = (typeof EXPIRY_TYPES)[number];
export const EXPIRY_LABELS: Record<ExpiryTypeT, string> = {
  NEVER: "Never",
  AFTER_FIRST_TRIGGER: "After first trigger",
  AT_DATE: "Specific date/time",
  AFTER_N_TRIGGERS: "Number of triggers",
};

export const ALERT_STATUSES = ["ACTIVE", "COOLDOWN", "DRAFT", "PAUSED", "TRIGGERED", "EXPIRED", "ERROR"] as const;
export type AlertStatusT = (typeof ALERT_STATUSES)[number];

export const PARSE_MODES = ["PLAIN", "MARKDOWN", "MARKDOWN_V2", "HTML"] as const;
export type ParseModeT = (typeof PARSE_MODES)[number];
export const PARSE_MODE_LABELS: Record<ParseModeT, string> = {
  PLAIN: "Plain text",
  MARKDOWN: "Markdown (legacy)",
  MARKDOWN_V2: "MarkdownV2",
  HTML: "HTML",
};

export const DELIVERY_STATUSES = ["QUEUED", "SENDING", "SENT", "RETRYING", "FAILED", "DEAD_LETTER"] as const;
export type DeliveryStatusT = (typeof DELIVERY_STATUSES)[number];

export const COOLDOWN_PRESETS = [
  { label: "No cooldown", value: 0 },
  { label: "10 seconds", value: 10 },
  { label: "30 seconds", value: 30 },
  { label: "1 minute", value: 60 },
  { label: "5 minutes", value: 300 },
  { label: "15 minutes", value: 900 },
] as const;

export const TEMPLATE_VARIABLES = [
  { key: "symbol", description: "Instrument symbol" },
  { key: "current_price", description: "Price that triggered the alert" },
  { key: "target_price", description: "Alert target" },
  { key: "condition", description: "Condition, e.g. Price Above" },
  { key: "alert_name", description: "Name of the alert" },
  { key: "time", description: "Trigger time (HH:mm:ss)" },
  { key: "date", description: "Trigger date (YYYY-MM-DD)" },
  { key: "percentage_distance", description: "Distance from target in %" },
  { key: "exchange", description: "Exchange / data source" },
  { key: "alert_id", description: "Alert identifier" },
] as const;

export const DEFAULT_TEMPLATE = `🚨 PRICE ALERT

Symbol: {{symbol}}

Current Price: {{current_price}}

Target: {{target_price}}

Condition: {{condition}}

Time: {{time}}

Alert: {{alert_name}}`;

export const DEFAULT_SYMBOLS = ["XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "NAS100", "US30"] as const;

/** Telegram's hard limit on message length (after entity parsing). */
export const TELEGRAM_MAX_MESSAGE = 4096;
