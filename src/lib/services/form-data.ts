import { db } from "@/lib/db";
import { defaultProviderKey, listProviders } from "@/lib/market-data/registry";
import { DEFAULT_TEMPLATE } from "@/lib/constants";
import { isTimeframe, type Timeframe } from "@/lib/market/timeframes";
import type { AlertFormValues } from "@/components/alerts/alert-form";
import type { AlertDTO } from "@/lib/services/alerts";

/** Data the alert form needs (bots without tokens, instruments, providers). */
export async function loadAlertFormData(userId: string) {
  const [bots, instruments] = await Promise.all([
    db.telegramBot.findMany({
      where: { userId },
      select: { id: true, name: true, status: true, chatTitle: true, chatId: true, enabled: true },
      orderBy: { createdAt: "asc" },
    }),
    db.instrument.findMany({ select: { symbol: true, displayName: true, provider: true, exchange: true }, orderBy: { symbol: "asc" } }),
  ]);
  return { bots, instruments, providers: listProviders(), defaultProvider: defaultProviderKey() };
}

export function valuesFromAlert(a: AlertDTO, opts: { duplicate?: boolean } = {}): AlertFormValues {
  return {
    name: opts.duplicate ? `${a.name} (copy)` : a.name,
    symbol: a.symbol,
    dataProvider: a.dataProvider,
    kind: a.kind,
    timeframe: (isTimeframe(a.timeframe) ? a.timeframe : "5m") as Timeframe,
    evaluationMode: a.evaluationMode,
    conditionTree: a.conditionTree,
    conditionType: a.conditionType,
    targetPrice: a.kind === "CONDITIONS" && !a.targetPrice ? "" : String(a.targetPrice),
    tolerance: a.tolerance ? String(a.tolerance) : "",
    telegramBotId: a.telegramBotId,
    messageTemplate: a.messageTemplate,
    parseMode: a.parseMode,
    triggerMode: a.triggerMode,
    cooldownSeconds: a.cooldownSeconds,
    expiryType: a.expiryType,
    // ISO string; the form converts it to a datetime-local value in the browser's timezone
    expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : "",
    maxTriggers: a.maxTriggers ? String(a.maxTriggers) : "",
    startAs: opts.duplicate
      ? "ACTIVE"
      : a.status === "DRAFT"
        ? "DRAFT"
        : a.status === "ACTIVE" || a.status === "COOLDOWN"
          ? "ACTIVE"
          : "PAUSED",
  };
}

const BREAKOUT_TEMPLATE = `🚀 BREAKOUT — {{symbol}}

{{symbol}} broke above {{target_price}}
Price: {{current_price}} ({{percentage_distance}})

{{date}} {{time}} · {{alert_name}}`;

const BREAKDOWN_TEMPLATE = `📉 BREAKDOWN — {{symbol}}

{{symbol}} broke below {{target_price}}
Price: {{current_price}} ({{percentage_distance}})

{{date}} {{time}} · {{alert_name}}`;

export const QUICK_TEMPLATES = {
  above: { label: "Price Above", conditionType: "PRICE_ABOVE", triggerMode: "REARM", name: "Price above", message: DEFAULT_TEMPLATE },
  below: { label: "Price Below", conditionType: "PRICE_BELOW", triggerMode: "REARM", name: "Price below", message: DEFAULT_TEMPLATE },
  breakout: { label: "Breakout", conditionType: "CROSSES_ABOVE", triggerMode: "REARM", name: "Breakout", message: BREAKOUT_TEMPLATE },
  breakdown: { label: "Breakdown", conditionType: "CROSSES_BELOW", triggerMode: "REARM", name: "Breakdown", message: BREAKDOWN_TEMPLATE },
} as const;
export type QuickTemplateKey = keyof typeof QUICK_TEMPLATES;

export function blankValues(defaultBotId: string | null, template?: string | null, symbol?: string | null): AlertFormValues {
  const t = template && template in QUICK_TEMPLATES ? QUICK_TEMPLATES[template as QuickTemplateKey] : null;
  const sym = symbol && /^[A-Z0-9][A-Z0-9._:/-]{0,23}$/.test(symbol) ? symbol : "XAUUSD";
  return {
    name: t ? `${sym} ${t.name.toLowerCase()}` : "",
    symbol: sym,
    dataProvider: defaultProviderKey(),
    kind: "PRICE",
    timeframe: "5m",
    evaluationMode: "CANDLE_CLOSE",
    conditionTree: null,
    conditionType: t?.conditionType ?? "PRICE_ABOVE",
    targetPrice: "",
    tolerance: "",
    telegramBotId: defaultBotId,
    messageTemplate: t?.message ?? DEFAULT_TEMPLATE,
    parseMode: "PLAIN",
    triggerMode: t?.triggerMode ?? "REARM",
    cooldownSeconds: 60,
    expiryType: "NEVER",
    expiresAt: "",
    maxTriggers: "",
    startAs: "ACTIVE",
  };
}
