"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Copy, FlaskConical, Loader2, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Send, Trash2, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertStatusBadge, AlertConditionCell, RelativeTime } from "@/components/status";
import { api, errorMessage } from "@/lib/client-api";
import { cn, formatPrice } from "@/lib/utils";
import type { AlertDTO } from "@/lib/services/alerts";

type Alert = Omit<AlertDTO, "createdAt" | "updatedAt" | "lastTriggeredAt" | "expiresAt"> & {
  createdAt: string | Date;
  updatedAt: string | Date;
  lastTriggeredAt: string | Date | null;
  expiresAt: string | Date | null;
};

const ALL = "__all";

export function AlertsTable({
  alerts,
  bots,
  symbols,
  filters,
}: {
  alerts: Alert[];
  bots: { id: string; name: string }[];
  symbols: string[];
  filters: { q?: string; status?: string; symbol?: string; botId?: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Alert | null>(null);
  const [simulate, setSimulate] = useState<Alert | null>(null);
  const [q, setQ] = useState(filters.q ?? "");

  // Keep prices and statuses fresh while the page is open.
  useEffect(() => {
    const t = setInterval(() => startTransition(() => router.refresh()), 10_000);
    return () => clearInterval(t);
  }, [router]);

  // Sync the search box when the URL query changes (e.g. top-bar search) — adjusted during render, not in an effect.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (syncedQ !== filters.q) {
    setSyncedQ(filters.q);
    setQ(filters.q ?? "");
  }

  function setFilter(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== ALL) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`);
  }

  async function act(a: Alert, action: "pause" | "resume" | "test" | "delete") {
    setBusy(`${a.id}:${action}`);
    try {
      if (action === "delete") {
        await api(`/api/alerts/${a.id}`, { method: "DELETE" });
        toast.success(`Deleted “${a.name}”`);
      } else if (action === "test") {
        const r = await api<{ result: { status: string; error?: string } }>(`/api/alerts/${a.id}/test`, { method: "POST" });
        if (r.result.status === "sent") toast.success(`Test alert sent to ${a.bot?.name ?? "Telegram"}`);
        else toast.error(r.result.error ?? "Telegram message could not be delivered. Please check your bot token and Chat ID.");
      } else {
        await api(`/api/alerts/${a.id}/${action}`, { method: "POST" });
        toast.success(action === "pause" ? `Paused “${a.name}”` : `Resumed “${a.name}”`);
      }
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const hasFilters = !!(filters.q || filters.status || filters.symbol || filters.botId);

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center">
        <form
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter("q", q.trim() || null);
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or symbol"
            className="pl-9"
            aria-label="Search alerts"
          />
        </form>
        <div className="grid grid-cols-3 gap-2 lg:flex">
          <Select value={filters.status ?? ALL} onValueChange={(v) => setFilter("status", v)}>
            <SelectTrigger className="lg:w-36" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="COOLDOWN">Cooldown</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="PAUSED">Paused</SelectItem>
              <SelectItem value="TRIGGERED">Triggered</SelectItem>
              <SelectItem value="EXPIRED">Expired</SelectItem>
              <SelectItem value="ERROR">Error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.symbol ?? ALL} onValueChange={(v) => setFilter("symbol", v)}>
            <SelectTrigger className="lg:w-36" aria-label="Filter by symbol">
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
          <Select value={filters.botId ?? ALL} onValueChange={(v) => setFilter("botId", v)}>
            <SelectTrigger className="lg:w-44" aria-label="Filter by Telegram bot">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All bots</SelectItem>
              {bots.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-16 text-center">
          <p className="font-medium">{hasFilters ? "No alerts match these filters" : "No alerts yet"}</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {hasFilters
              ? "Try clearing a filter or searching for a different symbol."
              : "Create an alert and you'll get a Telegram message the moment price reaches your level."}
          </p>
          {hasFilters ? (
            <Button variant="outline" className="mt-5" onClick={() => router.replace(pathname)}>
              Clear filters
            </Button>
          ) : (
            <Button asChild className="mt-5">
              <Link href="/alerts/new">
                <Plus /> Create Alert
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Alert name</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Current price</TableHead>
              <TableHead>Telegram</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last triggered</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alerts.map((a) => {
              const canToggle = a.status === "ACTIVE" || a.status === "COOLDOWN" || a.status === "PAUSED" || a.status === "DRAFT";
              const isLive = a.status === "ACTIVE" || a.status === "COOLDOWN";
              const toggling = busy === `${a.id}:pause` || busy === `${a.id}:resume`;
              return (
                <TableRow key={a.id}>
                  <TableCell className="max-w-56">
                    <Link href={`/alerts/${a.id}/edit`} className="block truncate font-medium hover:underline">
                      {a.name}
                    </Link>
                    {a.lastError && (
                      <span className="block max-w-56 truncate text-xs text-destructive" title={a.lastError}>
                        {a.lastError}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-semibold">{a.symbol}</TableCell>
                  <TableCell>
                    <AlertConditionCell alert={a} />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular">
                    {a.kind === "CONDITIONS" ? "—" : formatPrice(a.targetPrice)}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">{formatPrice(a.currentPrice)}</TableCell>
                  <TableCell className="max-w-40 truncate">
                    {a.bot ? a.bot.name : <span className="text-destructive">No bot</span>}
                  </TableCell>
                  <TableCell>
                    {canToggle ? (
                      <button
                        type="button"
                        onClick={() => act(a, isLive ? "pause" : "resume")}
                        disabled={toggling}
                        aria-label={isLive ? `Pause ${a.name}` : `Resume ${a.name}`}
                        title={isLive ? "Click to pause" : "Click to resume"}
                        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                      >
                        <AlertStatusBadge status={a.status} />
                      </button>
                    ) : (
                      <AlertStatusBadge status={a.status} />
                    )}
                  </TableCell>
                  <TableCell>
                    <RelativeTime date={a.lastTriggeredAt} />
                  </TableCell>
                  <TableCell>
                    <RelativeTime date={a.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => act(a, "test")}
                        disabled={busy === `${a.id}:test` || !a.bot}
                        aria-label={`Send test alert for ${a.name}`}
                        title="Send test alert"
                      >
                        {busy === `${a.id}:test` ? <Loader2 className="animate-spin" /> : <Send />}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${a.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/alerts/${a.id}/edit`}>
                              <Pencil /> Edit
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/alerts/new?from=${a.id}`}>
                              <Copy /> Duplicate
                            </Link>
                          </DropdownMenuItem>
                          {a.kind === "CONDITIONS" && (
                            <DropdownMenuItem asChild>
                              <Link href={`/alerts/${a.id}/debug`}>
                                <Bug /> Debug conditions
                              </Link>
                            </DropdownMenuItem>
                          )}
                          {a.status === "ACTIVE" ? (
                            <DropdownMenuItem onSelect={() => act(a, "pause")}>
                              <Pause /> Pause
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => act(a, "resume")}>
                              <Play /> Resume
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => act(a, "test")} disabled={!a.bot}>
                            <Send /> Send test alert
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setSimulate(a)}>
                            <FlaskConical /> Simulate price
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setToDelete(a)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description="The alert stops immediately. Its trigger history is kept."
        confirmLabel="Delete alert"
        onConfirm={() => toDelete && act(toDelete, "delete")}
      />
      {/* keyed by alert so its form state starts fresh for each alert */}
      <SimulateDialog key={simulate?.id ?? "closed"} alert={simulate} onClose={() => setSimulate(null)} onDone={() => router.refresh()} />
    </Card>
  );
}

function SimulateDialog({ alert, onClose, onDone }: { alert: Alert | null; onClose: () => void; onDone: () => void }) {
  const [price, setPrice] = useState("");
  const [pending, setPending] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!alert) return;
    setPending(true);
    try {
      const r = await api<{ quote: string; evaluated: number; triggered: number }>("/api/simulate", {
        method: "POST",
        body: { symbol: alert.symbol, price, provider: alert.dataProvider },
      });
      const line =
        r.quote !== "new"
          ? `${price}: ignored (${r.quote} price update)`
          : r.triggered
            ? `${price}: triggered — Telegram message queued`
            : `${price}: no trigger`;
      setLog((l) => [line, ...l].slice(0, 8));
      setPrice("");
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={!!alert} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Simulate a price for {alert?.symbol}</DialogTitle>
          <DialogDescription>
            Sends a price update through the alert engine for your own {alert?.symbol} alerts on this price source. Real Telegram messages
            are sent if an alert triggers.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={send} className="space-y-3">
          <div>
            <Label htmlFor="sim-price">Price</Label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="sim-price"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder={String(alert?.targetPrice ?? "")}
                autoFocus
                className="tabular"
              />
              <Button type="submit" disabled={!price || pending}>
                {pending && <Loader2 className="animate-spin" />}
                Send price
              </Button>
            </div>
          </div>
          {log.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm tabular">
              {log.map((l, i) => (
                <li key={i} className={cn(i === 0 ? "font-medium" : "text-muted-foreground")}>
                  {l}
                </li>
              ))}
            </ul>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
