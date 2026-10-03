"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, Equal, Loader2, Send, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LevelLadder } from "@/components/alerts/level-ladder";
import { ConditionBuilder, defaultTree, describeTree } from "@/components/alerts/condition-builder";
import type { ConditionNode } from "@/lib/conditions/types";
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from "@/lib/market/timeframes";
import { TelegramBubble } from "@/components/telegram-preview";
import { api, ApiError, errorMessage } from "@/lib/client-api";
import {
  CONDITION_HELP,
  CONDITION_LABELS,
  CONDITION_TYPES,
  COOLDOWN_PRESETS,
  DEFAULT_SYMBOLS,
  EXPIRY_LABELS,
  EXPIRY_TYPES,
  PARSE_MODE_LABELS,
  PARSE_MODES,
  TEMPLATE_VARIABLES,
  TRIGGER_MODE_HELP,
  TRIGGER_MODE_LABELS,
  TRIGGER_MODES,
  type ConditionTypeT,
  type ExpiryTypeT,
  type ParseModeT,
  type TriggerModeT,
} from "@/lib/constants";
import { buildVars, renderTemplate, testHeader, validateTemplate } from "@/lib/telegram/template";
import { cn, formatPrice } from "@/lib/utils";

export interface FormBot {
  id: string;
  name: string;
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  enabled: boolean;
  chatTitle: string | null;
  chatId: string;
}
export interface FormInstrument {
  symbol: string;
  displayName: string;
  provider: string;
  exchange: string | null;
}
export interface FormProvider {
  key: string;
  label: string;
  description: string;
  configured: boolean;
  pushOnly: boolean;
}

export interface AlertFormValues {
  name: string;
  symbol: string;
  dataProvider: string;
  kind: "PRICE" | "CONDITIONS";
  timeframe: Timeframe;
  evaluationMode: "CANDLE_CLOSE" | "EVERY_TICK";
  conditionTree: ConditionNode | null;
  conditionType: ConditionTypeT;
  targetPrice: string;
  tolerance: string;
  telegramBotId: string | null;
  messageTemplate: string;
  parseMode: ParseModeT;
  triggerMode: TriggerModeT;
  cooldownSeconds: number;
  expiryType: ExpiryTypeT;
  expiresAt: string; // datetime-local value
  maxTriggers: string;
  startAs: "ACTIVE" | "PAUSED" | "DRAFT";
}

const CONDITION_ICON: Record<ConditionTypeT, typeof ArrowUpRight> = {
  PRICE_ABOVE: ArrowUpRight,
  PRICE_BELOW: ArrowDownRight,
  CROSSES_ABOVE: TrendingUp,
  CROSSES_BELOW: TrendingDown,
  PRICE_EQUALS: Equal,
};

/** ISO timestamp → value for <input type="datetime-local"> in the browser's timezone. */
function toLocalInput(value: string) {
  if (!value || !/(Z|[+-]\d\d:\d\d)$/i.test(value)) return value;
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function cooldownText(s: number) {
  if (!s) return "no cooldown";
  if (s < 60) return `${s} seconds`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return `${s} seconds`;
}

function conditionSentence(c: ConditionTypeT, symbol: string, target: string) {
  const t = target || "…";
  switch (c) {
    case "PRICE_ABOVE":
      return `${symbol} is at or above ${t}`;
    case "PRICE_BELOW":
      return `${symbol} is at or below ${t}`;
    case "CROSSES_ABOVE":
      return `${symbol} crosses up through ${t}`;
    case "CROSSES_BELOW":
      return `${symbol} crosses down through ${t}`;
    case "PRICE_EQUALS":
      return `${symbol} equals ${t}`;
  }
}

/** Numbered form section — the numbers reflect the actual order of the setup flow. */
function Section({
  n,
  title,
  description,
  children,
  id,
}: {
  n: number;
  title: string;
  description?: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section aria-labelledby={id} className="rounded-xl border bg-card">
      <header className="flex items-start gap-3 border-b px-5 py-4">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white dark:bg-secondary">
          {n}
        </span>
        <div>
          <h2 id={id} className="text-[15px] font-semibold">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </header>
      <div className="space-y-5 px-5 py-5">{children}</div>
    </section>
  );
}

function FieldError({ msg }: { msg?: string }) {
  return msg ? <p className="mt-1.5 text-xs text-destructive">{msg}</p> : null;
}

function OptionCard({
  checked,
  onSelect,
  title,
  description,
  icon,
  tone,
  name,
  value,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  icon?: React.ReactNode;
  tone?: "up" | "down";
  name: string;
  value: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 rounded-lg border px-3.5 py-3 transition-colors hover:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
        checked && "border-foreground/70 bg-muted/40 ring-1 ring-foreground/70",
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className="sr-only" />
      {icon && (
        <span className={cn("mt-0.5", tone === "up" && "text-up", tone === "down" && "text-down", !tone && "text-muted-foreground")}>
          {icon}
        </span>
      )}
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export function AlertForm({
  mode,
  alertId,
  initial,
  bots,
  instruments,
  providers,
  defaultProvider,
  timezone,
}: {
  mode: "create" | "edit";
  alertId?: string;
  initial: AlertFormValues;
  bots: FormBot[];
  instruments: FormInstrument[];
  providers: FormProvider[];
  defaultProvider: string;
  timezone: string;
}) {
  const router = useRouter();
  const [v, setV] = useState<AlertFormValues>(() => ({ ...initial, expiresAt: toLocalInput(initial.expiresAt) }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [providerTouched, setProviderTouched] = useState(mode === "edit");
  const [customCooldown, setCustomCooldown] = useState(!COOLDOWN_PRESETS.some((p) => p.value === initial.cooldownSeconds));
  const [price, setPrice] = useState<{ price: number | null; updatedAt: string | null; error: string | null; loading: boolean }>({
    price: null,
    updatedAt: null,
    error: null,
    loading: false,
  });
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof AlertFormValues>(k: K, val: AlertFormValues[K]) => {
    setV((s) => ({ ...s, [k]: val }));
    setErrors((e) => (e[k] ? { ...e, [k]: "" } : e));
  };

  const providerMap = useMemo(() => new Map(providers.map((p) => [p.key, p])), [providers]);
  const instrumentMap = useMemo(() => new Map(instruments.map((i) => [i.symbol, i])), [instruments]);

  // Pick a sensible data provider for the symbol unless the user chose one explicitly.
  useEffect(() => {
    if (providerTouched) return;
    const inst = instrumentMap.get(v.symbol);
    const preferred = inst && providerMap.get(inst.provider)?.configured ? inst.provider : defaultProvider;
    if (preferred !== v.dataProvider) setV((s) => ({ ...s, dataProvider: preferred }));
  }, [v.symbol, providerTouched, instrumentMap, providerMap, defaultProvider, v.dataProvider]);

  // Live price for the selected symbol/provider.
  useEffect(() => {
    if (!/^[A-Z0-9][A-Z0-9._:/-]{0,23}$/.test(v.symbol)) {
      setPrice({ price: null, updatedAt: null, error: null, loading: false });
      return;
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setPrice((p) => ({ ...p, loading: true }));
      try {
        const r = await api<{ price: number | null; updatedAt: string | null; error: string | null }>(
          `/api/prices?symbol=${encodeURIComponent(v.symbol)}&provider=${encodeURIComponent(v.dataProvider)}`,
          { signal: ctrl.signal },
        );
        setPrice({ ...r, loading: false });
      } catch (err) {
        if ((err as Error).name !== "AbortError") setPrice((p) => ({ ...p, loading: false, error: errorMessage(err) }));
      }
      timer = setTimeout(load, 5000);
    };
    const debounce = setTimeout(load, 300);
    return () => {
      ctrl.abort();
      clearTimeout(debounce);
      clearTimeout(timer);
    };
  }, [v.symbol, v.dataProvider]);

  const target = Number(v.targetPrice);
  const targetValid = Number.isFinite(target) && target > 0;
  const bot = bots.find((b) => b.id === v.telegramBotId) ?? null;
  const exchange = instrumentMap.get(v.symbol)?.exchange ?? providerMap.get(v.dataProvider)?.label ?? v.dataProvider;

  const previewVars = useMemo(
    () =>
      buildVars({
        alertId: alertId ?? "new-alert",
        alertName: v.name || "Untitled alert",
        symbol: v.symbol || "SYMBOL",
        conditionType: v.conditionType,
        targetPrice: targetValid ? target : 0,
        currentPrice: price.price ?? (targetValid ? target : 0),
        exchange,
        timezone,
        ...(v.kind === "CONDITIONS"
          ? {
              hasTarget: false,
              timeframe: v.timeframe,
              conditionLabel: describeTree(v.conditionTree, v.timeframe),
              triggerReason: "All required conditions satisfied.",
              indicatorValues: "(values at the trigger candle)",
            }
          : {}),
      }),

    [
      alertId,
      v.name,
      v.symbol,
      v.conditionType,
      target,
      targetValid,
      price.price,
      exchange,
      timezone,
      v.kind,
      v.timeframe,
      v.conditionTree,
    ],
  );
  const rendered = useMemo(
    () => renderTemplate(v.messageTemplate, previewVars, v.parseMode),
    [v.messageTemplate, previewVars, v.parseMode],
  );
  const issues = useMemo(
    () => validateTemplate(v.messageTemplate, v.parseMode, previewVars),
    [v.messageTemplate, v.parseMode, previewVars],
  );
  const templateErrors = issues.filter((i) => i.level === "error");

  function insertVariable(key: string) {
    const el = templateRef.current;
    const token = `{{${key}}}`;
    if (!el) return set("messageTemplate", v.messageTemplate + token);
    const start = el.selectionStart ?? v.messageTemplate.length;
    const end = el.selectionEnd ?? start;
    const next = v.messageTemplate.slice(0, start) + token + v.messageTemplate.slice(end);
    set("messageTemplate", next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function payload() {
    return {
      name: v.name,
      symbol: v.symbol,
      dataProvider: v.dataProvider,
      kind: v.kind,
      timeframe: v.timeframe,
      evaluationMode: v.evaluationMode,
      conditionTree: v.kind === "CONDITIONS" ? v.conditionTree : undefined,
      conditionType: v.conditionType,
      targetPrice: v.kind === "CONDITIONS" ? undefined : v.targetPrice,
      tolerance: v.conditionType === "PRICE_EQUALS" ? v.tolerance || "0" : "0",
      telegramBotId: v.telegramBotId,
      messageTemplate: v.messageTemplate,
      parseMode: v.parseMode,
      triggerMode: v.triggerMode,
      cooldownSeconds: v.cooldownSeconds,
      expiryType: v.expiryType,
      expiresAt: v.expiryType === "AT_DATE" && v.expiresAt ? new Date(v.expiresAt).toISOString() : null,
      maxTriggers: v.expiryType === "AFTER_N_TRIGGERS" ? v.maxTriggers || null : null,
      status: v.startAs,
    };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (templateErrors.length) {
      setErrors((x) => ({ ...x, messageTemplate: templateErrors[0].message }));
      toast.error("Fix the Telegram message before saving.");
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") await api("/api/alerts", { method: "POST", body: payload() });
      else await api(`/api/alerts/${alertId}`, { method: "PUT", body: payload() });
      toast.success(mode === "create" ? "Alert saved" : "Alert updated");
      router.push("/alerts");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        toast.error(err.message);
        const first = Object.keys(err.fieldErrors)[0];
        if (first) document.getElementById(`f-${first}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else toast.error("Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!bot) return toast.error("Choose a Telegram bot first.");
    if (templateErrors.length) return toast.error(templateErrors[0].message);
    setTesting(true);
    try {
      const r = await api<{ result: { status: string; error?: string } }>("/api/telegram/test", {
        method: "POST",
        body: { botId: bot.id, message: testHeader(v.parseMode) + rendered, parseMode: v.parseMode },
      });
      if (r.result.status === "sent") toast.success(`Test message sent to ${bot.chatTitle ?? bot.name}`);
      else toast.error(r.result.error ?? "Telegram message could not be delivered. Please check your bot token and Chat ID.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  const provider = providerMap.get(v.dataProvider);
  const rearmSide = v.conditionType === "PRICE_ABOVE" || v.conditionType === "CROSSES_ABOVE" ? "below" : "above";

  return (
    <form onSubmit={save} noValidate className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-5">
        {/* 1 ── Details */}
        <Section n={1} id="s-details" title="Alert details" description="What to watch.">
          <div>
            <Label htmlFor="f-name">Alert name</Label>
            <Input
              id="f-name"
              className="mt-1.5"
              placeholder="Gold Breakout Alert"
              value={v.name}
              maxLength={100}
              onChange={(e) => set("name", e.target.value)}
              aria-invalid={!!errors.name}
            />
            <FieldError msg={errors.name} />
          </div>
          <div>
            <Label htmlFor="f-symbol">Symbol</Label>
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Common symbols">
              {DEFAULT_SYMBOLS.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => set("symbol", s)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[13px] font-medium transition-colors hover:bg-muted",
                    v.symbol === s &&
                      "border-ink bg-ink text-white hover:bg-ink dark:border-primary dark:bg-primary dark:text-primary-foreground",
                  )}
                  aria-pressed={v.symbol === s}
                >
                  {s}
                </button>
              ))}
            </div>
            <Input
              id="f-symbol"
              className="mt-2.5 uppercase"
              list="symbol-options"
              placeholder="Or type any symbol, e.g. ETHUSD"
              value={v.symbol}
              maxLength={24}
              onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/\s/g, ""))}
              aria-invalid={!!errors.symbol}
              aria-describedby="symbol-help"
            />
            <datalist id="symbol-options">
              {instruments.map((i) => (
                <option key={i.symbol} value={i.symbol}>
                  {i.displayName}
                </option>
              ))}
            </datalist>
            <p id="symbol-help" className="mt-1.5 text-xs text-muted-foreground">
              {instrumentMap.get(v.symbol)?.displayName ?? "Custom symbols work with any data source that knows them."}
            </p>
            <FieldError msg={errors.symbol} />
          </div>
          <div>
            <Label htmlFor="f-dataProvider">Price source</Label>
            <Select
              value={v.dataProvider}
              onValueChange={(val) => {
                setProviderTouched(true);
                set("dataProvider", val);
              }}
            >
              <SelectTrigger id="f-dataProvider" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.key} value={p.key} disabled={!p.configured && p.key !== v.dataProvider}>
                    {p.label}
                    {!p.configured && " (not configured)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {provider?.description}
              {provider?.pushOnly && (
                <>
                  {" "}
                  Create a webhook key in{" "}
                  <Link href="/settings" className="underline">
                    Settings
                  </Link>
                  .
                </>
              )}
            </p>
          </div>
        </Section>

        {/* 2 ── Condition */}
        <Section n={2} id="s-condition" title="Condition" description="When should the alert fire?">
          <fieldset>
            <legend className="sr-only">Alert type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <OptionCard
                name="kind"
                value="PRICE"
                checked={v.kind === "PRICE"}
                onSelect={() => set("kind", "PRICE")}
                title="Price level"
                description="One price, checked on every update."
              />
              <OptionCard
                name="kind"
                value="CONDITIONS"
                checked={v.kind === "CONDITIONS"}
                onSelect={() => {
                  set("kind", "CONDITIONS");
                  if (!v.conditionTree) set("conditionTree", defaultTree());
                }}
                title="Indicator conditions"
                description="Rules on candles: indicators, crossings, patterns, sessions, several timeframes."
              />
            </div>
          </fieldset>
          {v.kind === "CONDITIONS" ? (
            <div className="space-y-4" id="f-conditionTree">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="f-timeframe">Timeframe</Label>
                  <Select value={v.timeframe} onValueChange={(t) => set("timeframe", t as Timeframe)}>
                    <SelectTrigger id="f-timeframe" className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEFRAMES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {TIMEFRAME_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError msg={errors.timeframe} />
                </div>
                <div>
                  <Label htmlFor="f-evaluationMode">Evaluate</Label>
                  <Select value={v.evaluationMode} onValueChange={(m) => set("evaluationMode", m as AlertFormValues["evaluationMode"])}>
                    <SelectTrigger id="f-evaluationMode" className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CANDLE_CLOSE">On candle close (confirmed)</SelectItem>
                      <SelectItem value="EVERY_TICK">Intrabar (forming candle)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {v.evaluationMode === "CANDLE_CLOSE"
                      ? "Checked once per closed candle — matches backtests exactly; never repaints."
                      : "Checked on the forming candle — earlier, but the candle can still change. At most one trigger per candle."}
                  </p>
                </div>
              </div>
              <ConditionBuilder
                value={v.conditionTree}
                onChange={(t) => set("conditionTree", t)}
                baseTimeframe={v.timeframe}
                error={errors.conditionTree}
              />
            </div>
          ) : (
            <>
              <fieldset>
                <legend className="sr-only">Condition type</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CONDITION_TYPES.map((c) => {
                    const Icon = CONDITION_ICON[c];
                    const tone = c === "PRICE_EQUALS" ? undefined : c.includes("ABOVE") ? "up" : "down";
                    return (
                      <OptionCard
                        key={c}
                        name="conditionType"
                        value={c}
                        checked={v.conditionType === c}
                        onSelect={() => set("conditionType", c)}
                        title={CONDITION_LABELS[c]}
                        description={CONDITION_HELP[c]}
                        icon={<Icon className="size-[18px]" />}
                        tone={tone}
                      />
                    );
                  })}
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="f-targetPrice">Target price</Label>
                  <Input
                    id="f-targetPrice"
                    className="mt-1.5 text-base font-semibold tabular"
                    inputMode="decimal"
                    placeholder="3900"
                    value={v.targetPrice}
                    onChange={(e) => set("targetPrice", e.target.value.replace(/[^0-9.]/g, ""))}
                    aria-invalid={!!errors.targetPrice}
                  />
                  <FieldError msg={errors.targetPrice} />
                  {price.price !== null && (
                    <button
                      type="button"
                      className="mt-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => set("targetPrice", String(price.price))}
                    >
                      Use current price {formatPrice(price.price)}
                    </button>
                  )}
                </div>
                {v.conditionType === "PRICE_EQUALS" && (
                  <div>
                    <Label htmlFor="f-tolerance">Tolerance (±)</Label>
                    <Input
                      id="f-tolerance"
                      className="mt-1.5 tabular"
                      inputMode="decimal"
                      placeholder="0.50"
                      value={v.tolerance}
                      onChange={(e) => set("tolerance", e.target.value.replace(/[^0-9.]/g, ""))}
                    />
                    <p className="mt-1.5 text-xs text-muted-foreground">Prices rarely hit an exact value — allow a small band.</p>
                  </div>
                )}
              </div>
            </>
          )}
        </Section>

        {/* 3 ── Trigger settings */}
        <Section n={3} id="s-trigger" title="Trigger settings" description="How often the alert can notify you.">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Frequency</legend>
            <div className="grid gap-2 md:grid-cols-3">
              {TRIGGER_MODES.map((m) => (
                <OptionCard
                  key={m}
                  name="triggerMode"
                  value={m}
                  checked={v.triggerMode === m}
                  onSelect={() => set("triggerMode", m)}
                  title={TRIGGER_MODE_LABELS[m]}
                  description={
                    m === "REARM"
                      ? v.kind === "CONDITIONS"
                        ? "Fires once, then waits until the conditions are false again."
                        : `Fires once, then waits for price to move back ${rearmSide} the target.`
                      : TRIGGER_MODE_HELP[m]
                  }
                />
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Cooldown</legend>
            <div className="flex flex-wrap gap-1.5">
              {COOLDOWN_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  aria-pressed={!customCooldown && v.cooldownSeconds === p.value}
                  onClick={() => {
                    setCustomCooldown(false);
                    set("cooldownSeconds", p.value);
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[13px] transition-colors hover:bg-muted",
                    !customCooldown &&
                      v.cooldownSeconds === p.value &&
                      "border-ink bg-ink text-white hover:bg-ink dark:border-primary dark:bg-primary dark:text-primary-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={customCooldown}
                onClick={() => setCustomCooldown(true)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[13px] transition-colors hover:bg-muted",
                  customCooldown &&
                    "border-ink bg-ink text-white hover:bg-ink dark:border-primary dark:bg-primary dark:text-primary-foreground",
                )}
              >
                Custom
              </button>
            </div>
            {customCooldown && (
              <div className="mt-3 flex items-center gap-2">
                <Input
                  id="f-cooldownSeconds"
                  className="w-32 tabular"
                  inputMode="numeric"
                  value={String(v.cooldownSeconds)}
                  onChange={(e) => set("cooldownSeconds", Math.min(604800, Number(e.target.value.replace(/\D/g, "") || 0)))}
                  aria-label="Cooldown in seconds"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            )}
            <FieldError msg={errors.cooldownSeconds} />
            {v.triggerMode === "EVERY_TIME" && v.cooldownSeconds < 30 && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-[#8a5a00] dark:text-signal">
                <AlertTriangle className="size-3.5" /> With “every time” and a short cooldown you may get a message on every price update.
              </p>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="f-expiryType">Expires</Label>
              <Select value={v.expiryType} onValueChange={(val) => set("expiryType", val as ExpiryTypeT)}>
                <SelectTrigger id="f-expiryType" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_TYPES.map((x) => (
                    <SelectItem key={x} value={x}>
                      {EXPIRY_LABELS[x]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {v.expiryType === "AT_DATE" && (
              <div>
                <Label htmlFor="f-expiresAt">Expiry date and time</Label>
                <Input
                  id="f-expiresAt"
                  type="datetime-local"
                  className="mt-1.5"
                  value={v.expiresAt}
                  onChange={(e) => set("expiresAt", e.target.value)}
                  aria-invalid={!!errors.expiresAt}
                />
                <FieldError msg={errors.expiresAt} />
              </div>
            )}
            {v.expiryType === "AFTER_N_TRIGGERS" && (
              <div>
                <Label htmlFor="f-maxTriggers">Number of triggers</Label>
                <Input
                  id="f-maxTriggers"
                  className="mt-1.5 tabular"
                  inputMode="numeric"
                  placeholder="3"
                  value={v.maxTriggers}
                  onChange={(e) => set("maxTriggers", e.target.value.replace(/\D/g, ""))}
                  aria-invalid={!!errors.maxTriggers}
                />
                <FieldError msg={errors.maxTriggers} />
              </div>
            )}
          </div>
        </Section>

        {/* 4 ── Telegram */}
        <Section n={4} id="s-telegram" title="Telegram" description="Where the notification is delivered.">
          {bots.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Connect a Telegram bot first. It takes about two minutes.</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/bots?add=1">
                  <Bot /> Add a bot
                </Link>
              </Button>
            </div>
          ) : (
            <div>
              <Label htmlFor="f-telegramBotId">Bot and chat</Label>
              <Select value={v.telegramBotId ?? ""} onValueChange={(val) => set("telegramBotId", val)}>
                <SelectTrigger id="f-telegramBotId" className="mt-1.5" aria-invalid={!!errors.telegramBotId}>
                  <SelectValue placeholder="Choose a bot" />
                </SelectTrigger>
                <SelectContent>
                  {bots.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          !b.enabled
                            ? "border border-muted-foreground"
                            : b.status === "CONNECTED"
                              ? "bg-up"
                              : b.status === "ERROR"
                                ? "bg-down"
                                : "bg-muted-foreground",
                        )}
                      />
                      {b.name}
                      <span className="text-muted-foreground">
                        · {b.chatTitle ?? b.chatId}
                        {!b.enabled && " (disabled)"}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError msg={errors.telegramBotId} />
              {bot && !bot.enabled && (
                <p className="mt-1.5 text-xs text-[#8a5a00] dark:text-signal">
                  This bot is disabled. Enable it on the Telegram Bots page, or save the alert paused.
                </p>
              )}
              {bot?.enabled && bot.status === "ERROR" && (
                <p className="mt-1.5 text-xs text-destructive">This bot has a connection problem. Check it on the Telegram Bots page.</p>
              )}
            </div>
          )}
        </Section>

        {/* 5 ── Message */}
        <Section
          n={5}
          id="s-message"
          title="Message"
          description="Write the Telegram message. Click a variable to insert it at the cursor."
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
            <div className="min-w-0">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <Label htmlFor="f-messageTemplate">Template</Label>
                <Select value={v.parseMode} onValueChange={(val) => set("parseMode", val as ParseModeT)}>
                  <SelectTrigger className="h-8 w-44 text-[13px]" aria-label="Formatting">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARSE_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {PARSE_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                id="f-messageTemplate"
                ref={templateRef}
                rows={14}
                spellCheck={false}
                className="font-mono text-[13px] leading-relaxed"
                value={v.messageTemplate}
                onChange={(e) => set("messageTemplate", e.target.value)}
                aria-invalid={!!errors.messageTemplate || templateErrors.length > 0}
                aria-describedby="template-issues"
              />
              <div id="template-issues" aria-live="polite" className="mt-1.5 space-y-1">
                {errors.messageTemplate && !templateErrors.length && <FieldError msg={errors.messageTemplate} />}
                {templateErrors.map((i) => (
                  <p key={i.message} className="text-xs text-destructive">
                    {i.message}
                  </p>
                ))}
                {!templateErrors.length && <p className="text-xs text-muted-foreground tabular">{rendered.length} / 4096 characters</p>}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium">Variables</div>
              <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:flex-nowrap">
                {TEMPLATE_VARIABLES.map((tv) => (
                  <li key={tv.key}>
                    <button
                      type="button"
                      onClick={() => insertVariable(tv.key)}
                      title={tv.description}
                      className="w-full rounded-md border bg-muted/40 px-2 py-1 text-left font-mono text-[12px] transition-colors hover:border-foreground/40 hover:bg-muted"
                    >
                      {`{{${tv.key}}}`}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>

        {/* 6 ── Preview (inline on small screens; the sticky column shows it on desktop) */}
        <Section n={6} id="s-preview" title="Preview" description="Exactly what Telegram will show, using the current price.">
          <TelegramBubble
            className="xl:hidden"
            text={rendered}
            mode={v.parseMode}
            botName={bot?.name ?? "Your bot"}
            time={previewVars.time.slice(0, 5)}
          />
          <p className="hidden text-sm text-muted-foreground xl:block">The live preview is pinned to the right and updates as you type.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={sendTest} disabled={testing || !bot}>
              {testing ? <Loader2 className="animate-spin" /> : <Send />}
              Send test to Telegram
            </Button>
            <span className="text-xs text-muted-foreground">Sent with a “Test alert” header. Nothing is saved.</span>
          </div>
        </Section>

        {/* 7 ── Review */}
        <Section n={7} id="s-review" title="Review" description="Check the summary, then save.">
          <dl className="divide-y rounded-lg border text-sm">
            <ReviewRow label="Watch">
              <strong>{v.symbol || "—"}</strong> via {provider?.label ?? v.dataProvider}
            </ReviewRow>
            <ReviewRow label="Fires when">
              {v.kind === "CONDITIONS"
                ? `${describeTree(v.conditionTree, v.timeframe)} — ${v.timeframe}, ${v.evaluationMode === "CANDLE_CLOSE" ? "on candle close" : "intrabar"}`
                : conditionSentence(v.conditionType, v.symbol || "price", v.targetPrice)}
            </ReviewRow>
            <ReviewRow label="Frequency">
              {v.triggerMode === "ONCE"
                ? "Once, then the alert stops"
                : v.triggerMode === "REARM"
                  ? v.kind === "CONDITIONS"
                    ? "Once per setup — re-arms when the conditions stop matching"
                    : `Once per move — re-arms after price goes back ${rearmSide} ${v.targetPrice || "the target"}`
                  : v.kind === "CONDITIONS"
                    ? "Every evaluation that meets the conditions (max one per candle)"
                    : "Every price update that meets the condition"}
              , {cooldownText(v.cooldownSeconds)} between messages
            </ReviewRow>
            <ReviewRow label="Expires">
              {v.expiryType === "AT_DATE"
                ? v.expiresAt
                  ? new Date(v.expiresAt).toLocaleString()
                  : "Pick a date"
                : v.expiryType === "AFTER_N_TRIGGERS"
                  ? `After ${v.maxTriggers || "N"} triggers`
                  : EXPIRY_LABELS[v.expiryType]}
            </ReviewRow>
            <ReviewRow label="Send to">
              {bot ? `${bot.name} · ${bot.chatTitle ?? bot.chatId}` : <span className="text-destructive">No bot selected</span>}
            </ReviewRow>
            <ReviewRow label="Format">{PARSE_MODE_LABELS[v.parseMode]}</ReviewRow>
          </dl>
          <div className="rounded-lg border px-4 py-3">
            <span className="block text-sm font-medium">Start as</span>
            <span className="block text-xs text-muted-foreground">
              {v.startAs === "DRAFT"
                ? "Draft: saved for later — it never evaluates until you activate it."
                : v.startAs === "PAUSED"
                  ? "Paused: saved and switchable on at any time."
                  : "Active: starts watching the market immediately."}
            </span>
            <Select value={v.startAs} onValueChange={(c) => set("startAs", c as AlertFormValues["startAs"])}>
              <SelectTrigger className="mt-2 w-44" aria-label="Start as">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="PAUSED">Paused</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Section>

        <div className="sticky bottom-0 z-20 -mx-4 flex justify-end gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:px-5">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} className="min-w-32">
            {saving && <Loader2 className="animate-spin" />}
            Save Alert
          </Button>
        </div>
      </div>

      <aside className="hidden xl:block">
        <div className="sticky top-24 space-y-4">
          {v.kind === "PRICE" && (
            <LevelLadder
              symbol={v.symbol}
              current={price.price}
              target={targetValid ? target : null}
              condition={v.conditionType}
              tolerance={Number(v.tolerance) || 0}
              loading={price.loading}
              error={price.error}
              updatedAt={price.updatedAt}
            />
          )}
          <TelegramBubble text={rendered} mode={v.parseMode} botName={bot?.name ?? "Your bot"} time={previewVars.time.slice(0, 5)} />
        </div>
      </aside>

      {/* On smaller screens the ladder sits above the form */}
      {v.kind === "PRICE" && (
        <div className="order-first xl:hidden">
          <LevelLadder
            symbol={v.symbol}
            current={price.price}
            target={targetValid ? target : null}
            condition={v.conditionType}
            tolerance={Number(v.tolerance) || 0}
            loading={price.loading}
            error={price.error}
            updatedAt={price.updatedAt}
          />
        </div>
      )}
    </form>
  );
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[120px_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
