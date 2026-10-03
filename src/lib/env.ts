import { z } from "zod";

/**
 * Centralised, validated access to server-side environment variables.
 * Values are read lazily so that `next build` works without a full runtime environment.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  APP_URL: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  TELEGRAM_API_URL: z.string().url().default("https://api.telegram.org"),
  REDIS_URL: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DEFAULT_MARKET_DATA_PROVIDER: z.string().default("simulated"),
  MARKET_DATA_API_KEY: z.string().optional(),
  CUSTOM_PRICE_URL: z.string().optional(),
  CUSTOM_PRICE_JSON_PATH: z.string().default("price"),
  CUSTOM_PRICE_API_KEY_HEADER: z.string().optional(),
  PRICE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

function parseEnv(): Env {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v])));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= parseEnv();
  return cached;
}

export function authSecret(): string {
  const s = env().NEXTAUTH_SECRET ?? env().AUTH_SECRET;
  if (!s || s.length < 16) {
    if (env().NODE_ENV === "production") throw new Error("NEXTAUTH_SECRET must be set (min 16 chars)");
    return "dev-only-insecure-secret-change-me";
  }
  return s;
}

export const isProd = () => env().NODE_ENV === "production";

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

/**
 * Boot-time validation, run once by the web server (src/instrumentation.ts) and the worker.
 * Errors abort startup; warnings are logged. Production requires real secrets — dev fallbacks are refused.
 */
export function checkEnv(): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let e: Env;
  try {
    e = parseEnv();
  } catch (err) {
    return { errors: [(err as Error).message], warnings };
  }
  const prod = e.NODE_ENV === "production";
  const need = (msg: string) => (prod ? errors : warnings).push(msg);

  const secret = e.NEXTAUTH_SECRET ?? e.AUTH_SECRET;
  if (!secret || secret.length < 16) need("NEXTAUTH_SECRET is missing or shorter than 16 characters (a dev-only fallback is in use).");

  if (!e.ENCRYPTION_KEY) need("ENCRYPTION_KEY is not set (bot tokens are encrypted with a dev-only key).");
  else if (Buffer.from(e.ENCRYPTION_KEY, "base64").length !== 32)
    errors.push("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");

  if (prod && !e.APP_URL) warnings.push("APP_URL is not set; cross-origin checks fall back to the Host header.");
  if (e.APP_URL && !/^https?:\/\//.test(e.APP_URL)) errors.push("APP_URL must start with http:// or https://.");
  if (e.REDIS_URL && !/^rediss?:\/\//.test(e.REDIS_URL)) errors.push("REDIS_URL must start with redis:// or rediss://.");
  if (!e.REDIS_URL) warnings.push("REDIS_URL is not set; queues run in database-outbox mode.");
  if (e.WEBHOOK_SECRET && e.WEBHOOK_SECRET.length < 16) errors.push("WEBHOOK_SECRET must be at least 16 characters.");
  if (prod && e.TELEGRAM_API_URL !== "https://api.telegram.org")
    warnings.push(`TELEGRAM_API_URL points to ${e.TELEGRAM_API_URL}, not the official Telegram API.`);
  const authMode = process.env.AUTH_MODE || "password";
  if (!["password", "local"].includes(authMode)) errors.push(`AUTH_MODE must be "password" or "local" (got "${authMode}").`);
  if (authMode === "local") {
    if (process.env.LEVELS_LOOPBACK_ONLY === "1") warnings.push("AUTH_MODE=local: no sign-in for http://localhost (server bound to 127.0.0.1 only).");
    else
      warnings.push(
        "AUTH_MODE=local is ignored: this server was not started with `npm run dev` / `npm run start:local` (loopback-only), so sign-in stays required.",
      );
  }
  if (e.DEFAULT_MARKET_DATA_PROVIDER === "simulated")
    warnings.push("DEFAULT_MARKET_DATA_PROVIDER is 'simulated' (mock prices, not live data).");
  if (e.DEFAULT_MARKET_DATA_PROVIDER === "twelvedata" && !e.MARKET_DATA_API_KEY)
    errors.push("DEFAULT_MARKET_DATA_PROVIDER=twelvedata requires MARKET_DATA_API_KEY.");

  return { errors, warnings };
}
