"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, Switch } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConditionLabel, DeliveryBadge } from "@/components/status";
import { formatPrice, cn } from "@/lib/utils";
import type { HistoryItem, DeliveryLogItem } from "@/lib/services/history";

type Paged<T> = { total: number; page: number; pageSize: number; items: T[] };
type Json<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] extends object | null ? Json<T[K]> : T[K];
};

const ALL = "__all";

function fmtDate(s: string | null) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function HistoryView({
  tab,
  history,
  deliveries,
  symbols,
  params,
}: {
  tab: "triggers" | "deliveries";
  history: Paged<Json<HistoryItem>> | null;
  deliveries: Paged<Json<DeliveryLogItem>> | null;
  symbols: string[];
  params: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function go(next: Record<string, string | null>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v && v !== ALL) p.set(k, v);
      else p.delete(k);
    }
    if (!("page" in next)) p.delete("page");
    router.replace(`${pathname}?${p.toString()}`);
  }

  const data = tab === "triggers" ? history : deliveries;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1 self-start" role="tablist">
          {(["triggers", "deliveries"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => router.replace(`${pathname}?tab=${t}`)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground",
                tab === t && "bg-card text-foreground shadow-sm",
              )}
            >
              {t === "triggers" ? "Triggers" : "Delivery log"}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {tab === "triggers" && (
            <>
              <div>
                <Label htmlFor="h-from" className="text-xs text-muted-foreground">
                  From
                </Label>
                <Input
                  id="h-from"
                  type="date"
                  className="mt-1 w-40"
                  defaultValue={params.from ?? ""}
                  onChange={(e) => go({ from: e.target.value || null })}
                />
              </div>
              <div>
                <Label htmlFor="h-to" className="text-xs text-muted-foreground">
                  To
                </Label>
                <Input
                  id="h-to"
                  type="date"
                  className="mt-1 w-40"
                  defaultValue={params.to ?? ""}
                  onChange={(e) => go({ to: e.target.value || null })}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Symbol</Label>
                <Select value={params.symbol ?? ALL} onValueChange={(v) => go({ symbol: v })}>
                  <SelectTrigger className="mt-1 w-36" aria-label="Filter by symbol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All symbols</SelectItem>
                    {symbols.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div>
            <Label className="text-xs text-muted-foreground">Delivery</Label>
            <Select value={params.status ?? ALL} onValueChange={(v) => go({ status: v })}>
              <SelectTrigger className="mt-1 w-36" aria-label="Filter by delivery status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any status</SelectItem>
                <SelectItem value="SENT">Delivered</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {tab === "triggers" && (
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch checked={params.includeTests === "true"} onCheckedChange={(c) => go({ includeTests: c ? "true" : null })} />
              Include test alerts
            </label>
          )}
        </div>
      </div>

      {tab === "triggers" && history && <TriggersTable items={history.items} />}
      {tab === "deliveries" && deliveries && <DeliveriesTable items={deliveries.items} />}

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between border-t px-5 py-3 text-sm text-muted-foreground">
          <span className="tabular">
            {(data.page - 1) * data.pageSize + 1}–{Math.min(data.total, data.page * data.pageSize)} of {data.total}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={data.page <= 1}
              onClick={() => go({ page: String(data.page - 1) })}
              aria-label="Previous page"
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={data.page >= pages}
              onClick={() => go({ page: String(data.page + 1) })}
              aria-label="Next page"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-6 py-16 text-center text-sm text-muted-foreground">{text}</p>;
}

function TriggersTable({ items }: { items: Json<HistoryItem>[] }) {
  if (!items.length) return <Empty text="No triggers match these filters. When an alert fires it is recorded here." />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Date/time</TableHead>
          <TableHead>Alert</TableHead>
          <TableHead>Symbol</TableHead>
          <TableHead className="text-right">Trigger price</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead>Telegram bot</TableHead>
          <TableHead>Delivery</TableHead>
          <TableHead>Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="tabular text-muted-foreground">{fmtDate(e.triggeredAt)}</TableCell>
            <TableCell className="max-w-56">
              <div className="flex items-center gap-1.5">
                {e.isTest && <span className="rounded bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground">Test</span>}
                {e.alertId ? (
                  <Link href={`/alerts/${e.alertId}/edit`} className="truncate font-medium hover:underline">
                    {e.alertName}
                  </Link>
                ) : (
                  <span className="truncate font-medium">{e.alertName}</span>
                )}
              </div>
              <ConditionLabel condition={e.conditionType} className="text-xs" />
            </TableCell>
            <TableCell className="font-semibold">{e.symbol}</TableCell>
            <TableCell className="text-right font-medium tabular">{formatPrice(e.triggerPrice)}</TableCell>
            <TableCell className="text-right tabular text-muted-foreground">{formatPrice(e.targetPrice)}</TableCell>
            <TableCell>{e.delivery?.botName ?? "—"}</TableCell>
            <TableCell>
              <DeliveryBadge status={e.delivery?.status ?? e.status} />
            </TableCell>
            <TableCell className="max-w-72 whitespace-normal text-xs text-destructive">{e.delivery?.error ?? ""}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeliveriesTable({ items }: { items: Json<DeliveryLogItem>[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <Empty text="No Telegram messages have been sent yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Created</TableHead>
          <TableHead>Alert</TableHead>
          <TableHead>Bot</TableHead>
          <TableHead>Chat ID</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Sent at</TableHead>
          <TableHead>Message ID</TableHead>
          <TableHead className="text-right">Attempts</TableHead>
          <TableHead>
            <span className="sr-only">Details</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((d) => (
          <Fragment key={d.id}>
            <TableRow>
              <TableCell className="tabular text-muted-foreground">{fmtDate(d.createdAt)}</TableCell>
              <TableCell className="max-w-48 truncate">
                {d.isTest && (
                  <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground">Test</span>
                )}
                {d.alertName ?? (d.alertId ? "Deleted alert" : "Bot test")}
              </TableCell>
              <TableCell>{d.botName}</TableCell>
              <TableCell className="tabular">{d.chatId}</TableCell>
              <TableCell>
                <DeliveryBadge status={d.status} />
              </TableCell>
              <TableCell className="tabular text-muted-foreground">{fmtDate(d.sentAt)}</TableCell>
              <TableCell className="tabular">{d.telegramMessageId ?? "—"}</TableCell>
              <TableCell className="text-right tabular">{d.attempts}</TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                  aria-expanded={open === d.id}
                  aria-label="Show message and error"
                >
                  <ChevronDown className={cn("transition-transform", open === d.id && "rotate-180")} />
                </Button>
              </TableCell>
            </TableRow>
            {open === d.id && (
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={9} className="whitespace-normal">
                  <div className="grid gap-4 py-1 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">Message ({d.parseMode.replace("_", " ").toLowerCase()})</div>
                      <pre className="max-h-64 overflow-auto rounded-md border bg-card p-3 text-xs whitespace-pre-wrap">{d.message}</pre>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">Error</div>
                        <div className={d.error ? "text-destructive" : "text-muted-foreground"}>{d.error ?? "None"}</div>
                      </div>
                      {d.errorDetail && (
                        <div>
                          <div className="text-xs text-muted-foreground">Telegram response</div>
                          <code className="text-xs break-all">{d.errorDetail}</code>
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
