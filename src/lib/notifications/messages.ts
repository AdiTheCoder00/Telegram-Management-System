import { db } from "@/lib/db";
import type { Alert } from "@/generated/prisma/client";
import { getProvider } from "@/lib/market-data/registry";
import { buildVars, renderTemplate, testHeader } from "@/lib/telegram/template";

const exchangeCache = new Map<string, { value: string | null; at: number }>();

async function exchangeFor(symbol: string, provider: string): Promise<string> {
  const cached = exchangeCache.get(symbol);
  let exchange: string | null;
  if (cached && Date.now() - cached.at < 5 * 60_000) exchange = cached.value;
  else {
    const inst = await db.instrument.findUnique({ where: { symbol }, select: { exchange: true } });
    exchange = inst?.exchange ?? null;
    exchangeCache.set(symbol, { value: exchange, at: Date.now() });
  }
  return exchange ?? getProvider(provider)?.label ?? provider;
}

type AlertLike = Pick<
  Alert,
  "id" | "name" | "symbol" | "conditionType" | "targetPrice" | "messageTemplate" | "parseMode" | "dataProvider"
> &
  Partial<Pick<Alert, "kind" | "timeframe">>;

/** Extra template values from a condition-tree evaluation (M6 variables). */
export interface MessageExtras {
  conditionLabel?: string;
  triggerReason?: string;
  indicatorValues?: string;
}

/** Renders an alert's template into the final Telegram message text. */
export async function buildAlertMessage(
  alert: AlertLike,
  opts: { price: number; at?: Date; timezone?: string; test?: boolean; extras?: MessageExtras },
): Promise<string> {
  const conditions = alert.kind === "CONDITIONS";
  const vars = buildVars({
    alertId: alert.id,
    alertName: alert.name,
    symbol: alert.symbol,
    conditionType: alert.conditionType,
    targetPrice: alert.targetPrice,
    currentPrice: opts.price,
    exchange: await exchangeFor(alert.symbol, alert.dataProvider),
    at: opts.at,
    timezone: opts.timezone,
    timeframe: conditions ? (alert.timeframe ?? null) : null,
    hasTarget: !conditions,
    conditionLabel: opts.extras?.conditionLabel ?? (conditions ? "Custom conditions" : null),
    triggerReason: opts.extras?.triggerReason ?? null,
    indicatorValues: opts.extras?.indicatorValues ?? null,
  });
  const body = renderTemplate(alert.messageTemplate, vars, alert.parseMode);
  return opts.test ? testHeader(alert.parseMode) + body : body;
}
