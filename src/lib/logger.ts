/**
 * Minimal structured logger (JSON lines in production, readable in development).
 * Technical details are logged server-side; users only ever see friendly messages.
 */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /token|secret|password|authorization|apikey|api_key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]),
  );
}

/** Removes bot tokens from strings such as Telegram URLs (https://api.telegram.org/bot<token>/...). */
export function scrubSecrets(s: string): string {
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  const min = (process.env.LOG_LEVEL as Level) || "info";
  if (order[level] < (order[min] ?? 20)) return;
  const entry = { time: new Date().toISOString(), level, msg: scrubSecrets(msg), ...(redact(meta ?? {}) as object) };
  const line =
    process.env.NODE_ENV === "production"
      ? scrubSecrets(JSON.stringify(entry))
      : `${entry.time} ${level.toUpperCase().padEnd(5)} ${entry.msg}${meta ? " " + scrubSecrets(JSON.stringify(redact(meta))) : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log("error", m, meta),
};
