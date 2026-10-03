import { z } from "zod";
import { ALERT_STATUSES, CONDITION_TYPES, DELIVERY_STATUSES, EXPIRY_TYPES, PARSE_MODES, TRIGGER_MODES } from "@/lib/constants";

// ─── Auth ───────────────────────────────────────────────────────────────────

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(128, "Password is too long.")
  .regex(/[a-zA-Z]/, "Password must contain a letter.")
  .regex(/[0-9]/, "Password must contain a number.");

export const timezoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone.");

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80),
  email: emailSchema,
  password: passwordSchema,
  /** Browser-detected IANA zone; invalid values fall back to UTC rather than failing sign-up. */
  timezone: timezoneSchema.optional().catch(undefined),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(128),
  newPassword: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required.").max(128),
});

// ─── Telegram bots ──────────────────────────────────────────────────────────

export const botTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, "That doesn't look like a Telegram bot token (format 123456:ABC…).");

/** Numeric ids (users/groups/channels, e.g. -1001234567890) or a public @channelusername. */
export const chatIdSchema = z
  .string()
  .trim()
  .regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, "Chat ID must be a number like -1001234567890 or an @channel username.");

export const createBotSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80),
  token: botTokenSchema,
  chatId: chatIdSchema,
});

export const updateBotSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  token: botTokenSchema.optional(), // only sent when the user replaces the token
  chatId: chatIdSchema.optional(),
});

export const telegramTestSchema = z.union([
  z.object({
    botId: z.string().min(1).max(40),
    message: z.string().max(4096).optional(),
    /** When set, the message is sent as-is with this parse mode (used by the alert form preview). */
    parseMode: z.enum(PARSE_MODES).optional(),
  }),
  z.object({ token: botTokenSchema, chatId: chatIdSchema, message: z.string().max(1000).optional() }),
]);

// ─── Alerts ─────────────────────────────────────────────────────────────────

export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._:/-]{0,23}$/, "Symbol may contain letters, numbers and . _ : / - (max 24 chars).");

const finitePositive = z.coerce
  .number({ message: "Enter a number." })
  .refine((n) => Number.isFinite(n), "Enter a valid number.")
  .refine((n) => n > 0, "Must be greater than 0.")
  .refine((n) => n < 1e12, "Value is too large.");

const alertBase = z.object({
  name: z.string().trim().min(1, "Give the alert a name.").max(100),
  symbol: symbolSchema,
  dataProvider: z.string().trim().min(1).max(40),
  conditionType: z.enum(CONDITION_TYPES),
  targetPrice: finitePositive,
  tolerance: z.coerce.number().min(0).max(1e9).default(0),
  telegramBotId: z.string().min(1).max(40).nullable(),
  messageTemplate: z.string().trim().min(1, "Message cannot be empty.").max(3500, "Message template is too long (max 3500 chars)."),
  parseMode: z.enum(PARSE_MODES).default("PLAIN"),
  triggerMode: z.enum(TRIGGER_MODES).default("REARM"),
  cooldownSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600, "Cooldown can be at most 7 days."),
  expiryType: z.enum(EXPIRY_TYPES).default("NEVER"),
  expiresAt: z.coerce.date().nullable().optional(),
  maxTriggers: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  status: z.enum(["ACTIVE", "PAUSED"]).default("ACTIVE"),
});

type AlertBase = z.infer<typeof alertBase>;

function refineAlert(v: Partial<AlertBase>, ctx: z.RefinementCtx) {
  if (v.expiryType === "AT_DATE") {
    if (!v.expiresAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Choose an expiry date/time." });
    else if (v.expiresAt.getTime() <= Date.now())
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must be in the future." });
  }
  if (v.expiryType === "AFTER_N_TRIGGERS" && !v.maxTriggers)
    ctx.addIssue({ code: "custom", path: ["maxTriggers"], message: "Enter how many triggers before expiry." });
  if (v.conditionType === "PRICE_EQUALS" && v.tolerance === 0 && v.targetPrice !== undefined) {
    // Allowed, but exact float equality is rarely hit — UI warns; engine treats tolerance 0 as exact match.
  }
}

export const alertInputSchema = alertBase.superRefine(refineAlert);
export type AlertInput = z.infer<typeof alertInputSchema>;

export const alertListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ALERT_STATUSES).optional(),
  symbol: symbolSchema.optional(),
  botId: z.string().max(40).optional(),
});

export const historyQuerySchema = z.object({
  symbol: symbolSchema.optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  alertId: z.string().max(40).optional(),
  includeTests: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ─── Webhook ────────────────────────────────────────────────────────────────

export const priceWebhookItem = z.object({
  symbol: symbolSchema,
  price: finitePositive,
  timestamp: z.coerce.date().optional(),
  /** Optional idempotency key; duplicate keys are ignored. */
  id: z.string().trim().min(1).max(128).optional(),
});

export const priceWebhookSchema = z.union([priceWebhookItem, z.object({ prices: z.array(priceWebhookItem).min(1).max(500) })]);

export const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: timezoneSchema.optional(),
});

export const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1).max(60) });
