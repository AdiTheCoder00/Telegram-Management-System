import { z } from "zod";
import { db } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { ingestTicks } from "@/lib/services/prices";
import { bucketEnd, bucketStart, isAligned, isTimeframe, type Timeframe } from "@/lib/market/timeframes";
import { ohlcProblems } from "@/lib/market/candles";
import { symbolSchema } from "@/lib/validation";

/**
 * Inbound webhooks (M13) — TradingView and generic JSON feeds.
 *
 *   POST /api/webhooks/tradingview/<secret>      (TradingView cannot send headers → secret in the URL)
 *   POST /api/webhooks/<webhookId>               (secret in X-Webhook-Secret / Authorization: Bearer)
 *
 * Payloads are either a TICK ({symbol, price}) or a BAR ({symbol, timeframe, time, open, high, low, close,
 * volume?}). Both enter the SAME engine as polled data: ticks go through processPriceTick (and build 1m tick
 * candles); bars are stored as pushed candles for the user's scope, which condition alerts on the "webhook"
 * provider read through the market-data service. The bar's close is also fed as a tick (at its close time) so
 * price alerts react.
 *
 * Secrets are random, shown once, stored as SHA-256. Idempotency: an explicit `id`, else bars are keyed by
 * (symbol, timeframe, open time); duplicate ticks are dropped by quote de-duplication.
 */
export const WEBHOOK_PREFIX = "whk_";
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_ITEMS = 100;

// ─── management ──────────────────────────────────────────────────────────────

export async function createWebhook(userId: string, input: { name: string; kind: "TRADINGVIEW" | "GENERIC" }) {
  const secret = `${WEBHOOK_PREFIX}${randomToken(24)}`;
  const w = await db.webhook.create({
    data: { userId, name: input.name, kind: input.kind, secretHash: sha256(secret), secretPrefix: secret.slice(0, 10) },
  });
  return { ...serializeWebhook(w), secret };
}

function serializeWebhook(w: {
  id: string;
  name: string;
  kind: string;
  secretPrefix: string;
  enabled: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: w.id,
    name: w.name,
    kind: w.kind,
    secretPrefix: w.secretPrefix,
    enabled: w.enabled,
    lastUsedAt: w.lastUsedAt,
    createdAt: w.createdAt,
  };
}
export type WebhookDTO = ReturnType<typeof serializeWebhook>;

export async function listWebhooks(userId: string) {
  const rows = await db.webhook.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return rows.map(serializeWebhook);
}

export async function setWebhookEnabled(userId: string, id: string, enabled: boolean) {
  const w = await db.webhook.findFirst({ where: { id, userId } });
  if (!w) throw notFound("Webhook");
  return serializeWebhook(await db.webhook.update({ where: { id }, data: { enabled } }));
}

export async function deleteWebhook(userId: string, id: string) {
  const w = await db.webhook.findFirst({ where: { id, userId } });
  if (!w) throw notFound("Webhook");
  await db.webhook.delete({ where: { id } });
}

/** Looks a webhook up by its raw secret (constant work: hash + unique index). Disabled webhooks resolve to null. */
export async function resolveWebhookSecret(secret: string | null | undefined, expectId?: string) {
  if (!secret || !secret.startsWith(WEBHOOK_PREFIX) || secret.length > 100) return null;
  const w = await db.webhook.findUnique({ where: { secretHash: sha256(secret) } });
  if (!w || !w.enabled || (expectId && w.id !== expectId)) return null;
  return w;
}

// ─── payloads ────────────────────────────────────────────────────────────────

/** TradingView {{interval}} values ("1", "5", "60", "240", "D", "1D", "W", "M") and our own ("5m", "1h"). */
export function parseInterval(v: string | number | undefined | null): Timeframe | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (isTimeframe(s)) return s;
  const tv: Record<string, Timeframe> = {
    "1": "1m",
    "3": "3m",
    "5": "5m",
    "15": "15m",
    "30": "30m",
    "60": "1h",
    "120": "2h",
    "240": "4h",
    D: "1d",
    "1D": "1d",
    W: "1w",
    "1W": "1w",
    M: "1M",
    "1M": "1M",
  };
  return tv[s.toUpperCase()] ?? tv[s] ?? null;
}

/** Epoch ms from ISO strings, epoch seconds or epoch ms (TradingView {{time}} / {{timenow}} are ISO UTC). */
export function parseTime(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

const num = z.union([z.number(), z.string().trim().min(1)]).transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: "Not a number" });
    return z.NEVER;
  }
  return n;
});

const itemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  symbol: z.string().trim().min(1).max(40).optional(),
  ticker: z.string().trim().min(1).max(40).optional(),
  price: num.optional(),
  timeframe: z.union([z.string(), z.number()]).optional(),
  interval: z.union([z.string(), z.number()]).optional(),
  time: z.union([z.string(), z.number()]).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  timenow: z.union([z.string(), z.number()]).optional(),
  open: num.optional(),
  high: num.optional(),
  low: num.optional(),
  close: num.optional(),
  volume: num.optional().nullable(),
});

export type ParsedItem =
  | { type: "tick"; id?: string; symbol: string; price: number; time: number }
  | {
      type: "bar";
      id?: string;
      symbol: string;
      timeframe: Timeframe;
      openTime: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
    };

/** "OANDA:XAUUSD" → "XAUUSD"; "BTCUSDT.P" stays as given (upper-cased). */
function normalizeSymbol(raw: string) {
  const s = raw.includes(":") ? raw.split(":").pop()! : raw;
  return symbolSchema.parse(s);
}

export function parsePayload(text: string, now = Date.now()): { items: ParsedItem[]; errors: string[] } {
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) throw badRequest(`Payload too large (max ${MAX_PAYLOAD_BYTES / 1024} KB).`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badRequest('Body must be JSON, e.g. {"symbol":"{{ticker}}","price":{{close}}}.');
  }
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { items?: unknown }).items)
      ? (json as { items: unknown[] }).items
      : [json];
  if (list.length > MAX_ITEMS) throw badRequest(`Too many items (max ${MAX_ITEMS}).`);

  const items: ParsedItem[] = [];
  const errors: string[] = [];
  list.forEach((raw, i) => {
    const r = itemSchema.safeParse(raw);
    if (!r.success) return errors.push(`item ${i}: ${r.error.issues[0]?.message ?? "invalid"}`);
    const v = r.data;
    let symbol: string;
    try {
      symbol = normalizeSymbol(v.symbol ?? v.ticker ?? "");
    } catch {
      return errors.push(`item ${i}: missing or invalid symbol`);
    }
    const tf = parseInterval(v.timeframe ?? v.interval);
    const isBar = tf && v.open !== undefined && v.high !== undefined && v.low !== undefined && v.close !== undefined;
    if (isBar) {
      const t = parseTime(v.time ?? v.timestamp);
      if (t === null) return errors.push(`item ${i}: bar needs a time (bar open time)`);
      // TradingView {{time}} is the bar OPEN time; accept a close-aligned time too by snapping into its bucket.
      const openTime = isAligned(t, tf) ? t : bucketStart(t, tf);
      if (openTime > now + 60_000) return errors.push(`item ${i}: bar time is in the future`);
      const c = { open: v.open!, high: v.high!, low: v.low!, close: v.close!, volume: v.volume ?? null };
      const bad = ohlcProblems(c);
      if (bad) return errors.push(`item ${i}: ${bad}`);
      items.push({ type: "bar", id: v.id, symbol, timeframe: tf, openTime, ...c });
      return;
    }
    const price = v.price ?? v.close;
    if (price === undefined || !(price > 0))
      return errors.push(`item ${i}: needs "price" (or a full bar with timeframe/open/high/low/close)`);
    const t = parseTime(v.timestamp ?? v.timenow ?? v.time) ?? now;
    if (t > now + 60_000) return errors.push(`item ${i}: timestamp is in the future`);
    items.push({ type: "tick", id: v.id, symbol, price, time: t });
  });
  return { items, errors };
}

// ─── ingestion ───────────────────────────────────────────────────────────────

async function claim(scope: string, key: string) {
  const r = await db.webhookReceipt.createMany({ data: [{ scope, key: key.slice(0, 200) }], skipDuplicates: true });
  return r.count === 1;
}

export async function ingestWebhook(webhook: { id: string; userId: string }, text: string, now = Date.now()) {
  const { items, errors } = parsePayload(text, now);
  const scope = webhook.userId; // pushed data only ever feeds its owner's alerts
  const ticks: { symbol: string; price: number; time: Date; fromBar?: boolean }[] = [];
  let bars = 0;
  let duplicates = 0;

  for (const it of items) {
    const key = it.id ? `id:${it.id}` : it.type === "bar" ? `bar:${it.symbol}:${it.timeframe}:${it.openTime}` : null;
    if (key && !(await claim(`webhook:${webhook.id}`, key))) {
      duplicates++;
      continue;
    }
    if (it.type === "bar") {
      const closeTime = bucketEnd(it.openTime, it.timeframe);
      const closed = closeTime <= now;
      await db.candle.upsert({
        where: {
          provider_scope_symbol_timeframe_openTime: {
            provider: "webhook",
            scope,
            symbol: it.symbol,
            timeframe: it.timeframe,
            openTime: new Date(it.openTime),
          },
        },
        create: {
          provider: "webhook",
          scope,
          symbol: it.symbol,
          timeframe: it.timeframe,
          openTime: new Date(it.openTime),
          open: it.open,
          high: it.high,
          low: it.low,
          close: it.close,
          volume: it.volume,
          volumeType: it.volume === null ? "UNAVAILABLE" : "PROVIDER",
          closed,
        },
        update: {
          open: it.open,
          high: it.high,
          low: it.low,
          close: it.close,
          volume: it.volume,
          volumeType: it.volume === null ? "UNAVAILABLE" : "PROVIDER",
          closed,
        },
      });
      bars++;
      ticks.push({ symbol: it.symbol, price: it.close, time: new Date(Math.min(closeTime, now)), fromBar: true });
    } else ticks.push({ symbol: it.symbol, price: it.price, time: new Date(it.time) });
  }

  const out = await ingestTicks("webhook", scope, ticks);
  await db.webhook.update({ where: { id: webhook.id }, data: { lastUsedAt: new Date(now) } }).catch(() => undefined);
  if (errors.length) logger.warn("Webhook items rejected", { webhookId: webhook.id, errors: errors.slice(0, 5) });
  return {
    accepted: ticks.length,
    bars,
    duplicates,
    rejected: errors,
    deliveryIds: out.deliveryIds,
    queued: out.queued,
    triggered: out.deliveryIds.length,
  };
}
