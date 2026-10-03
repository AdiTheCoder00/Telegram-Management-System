"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { ArrowDownRight, ArrowUpRight, Check, Clock, Equal, X, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/misc";
import { CONDITION_SHORT, type AlertStatusT, type ConditionTypeT, type DeliveryStatusT } from "@/lib/constants";
import { cn } from "@/lib/utils";

const STATUS: Record<AlertStatusT, { label: string; variant: "up" | "muted" | "signal" | "down" | "default"; dot: string }> = {
  ACTIVE: { label: "Active", variant: "up", dot: "bg-up" },
  COOLDOWN: { label: "Cooldown", variant: "default", dot: "bg-signal" },
  DRAFT: { label: "Draft", variant: "muted", dot: "border border-muted-foreground bg-transparent" },
  PAUSED: { label: "Paused", variant: "muted", dot: "border border-muted-foreground bg-transparent" },
  TRIGGERED: { label: "Triggered", variant: "signal", dot: "bg-signal" },
  EXPIRED: { label: "Expired", variant: "default", dot: "bg-muted-foreground/60" },
  ERROR: { label: "Error", variant: "down", dot: "bg-down" },
};

export function AlertStatusBadge({ status }: { status: AlertStatusT }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant}>
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </Badge>
  );
}

export function DeliveryBadge({ status }: { status: DeliveryStatusT | null | undefined }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  if (status === "SENT")
    return (
      <Badge variant="up">
        <Check /> Delivered
      </Badge>
    );
  if (status === "FAILED")
    return (
      <Badge variant="down">
        <X /> Failed
      </Badge>
    );
  if (status === "DEAD_LETTER")
    return (
      <Badge variant="down" title="Retries exhausted — use “Retry failed notifications” in Settings">
        <X /> Gave up
      </Badge>
    );
  if (status === "RETRYING")
    return (
      <Badge variant="signal">
        <Clock /> Retrying
      </Badge>
    );
  return (
    <Badge variant="signal">
      <Clock /> {status === "SENDING" ? "Sending" : "Queued"}
    </Badge>
  );
}

export function isUpward(c: ConditionTypeT) {
  return c === "PRICE_ABOVE" || c === "CROSSES_ABOVE";
}

export function ConditionLabel({ condition, className }: { condition: ConditionTypeT; className?: string }) {
  const Icon = condition === "PRICE_EQUALS" ? Equal : isUpward(condition) ? ArrowUpRight : ArrowDownRight;
  const tone = condition === "PRICE_EQUALS" ? "text-muted-foreground" : isUpward(condition) ? "text-up" : "text-down";
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", tone, className)}>
      <Icon className="size-4" />
      {CONDITION_SHORT[condition]}
    </span>
  );
}

export function RelativeTime({ date, fallback = "—" }: { date: string | Date | null | undefined; fallback?: string }) {
  if (!date) return <span className="text-muted-foreground">{fallback}</span>;
  const d = new Date(date);
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className="text-muted-foreground">
      {formatDistanceToNowStrict(d, { addSuffix: true })}
    </time>
  );
}

/** Condition column for alert rows: price-level label, or "Conditions · 5m" for condition-tree alerts. */
export function AlertConditionCell({
  alert,
}: {
  alert: { kind: string; conditionType: ConditionTypeT; timeframe: string; evaluationMode: string };
}) {
  if (alert.kind !== "CONDITIONS") return <ConditionLabel condition={alert.conditionType} />;
  return (
    <span
      className="inline-flex items-center gap-1 font-medium text-muted-foreground"
      title={alert.evaluationMode === "CANDLE_CLOSE" ? "Evaluated on candle close" : "Evaluated intrabar"}
    >
      <SlidersHorizontal className="size-4" />
      Conditions · {alert.timeframe}
    </span>
  );
}
