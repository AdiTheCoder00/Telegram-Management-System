"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronDown, Loader2, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EvaluationTree } from "@/components/evaluation-tree";
import { BacktestChart } from "@/components/backtest/backtest-chart";
import { api, errorMessage } from "@/lib/client-api";
import type { BacktestConfig, BacktestResult, BacktestTrigger } from "@/lib/backtest/engine";
import { cn } from "@/lib/utils";

interface AlertOption {
  id: string;
  name: string;
  symbol: string;
  timeframe: string;
  dataProvider: string;
  configVersion: number;
}

interface Run {
  id: string;
  alertId: string | null;
  alertVersion: number | null;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  config: BacktestConfig;
  dataset: {
    sha256?: string;
    synthetic?: boolean;
    timeframes?: Record<string, { source: string; candles: number; issues: number; first: string | null; last: string | null }>;
  } | null;
  engineVersions: Record<string, string>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  summary: BacktestResult["summary"] | null;
  triggers?: BacktestTrigger[];
}

const STATUS_TONE: Record<Run["status"], string> = {
  QUEUED: "text-muted-foreground",
  RUNNING: "text-signal",
  COMPLETED: "text-up",
  FAILED: "text-down",
  CANCELLED: "text-muted-foreground",
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const fmtPct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(2)}%`);
const fmtTime = (s: string) => s.replace("T", " ").replace(/:\d\d\.\d{3}Z$/, " UTC");

export function BacktestView({
  alerts,
  initialRuns,
  initialAlertId,
}: {
  alerts: AlertOption[];
  initialRuns: Run[];
  initialAlertId: string | null;
}) {
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [alertId, setAlertId] = useState(initialAlertId ?? alerts[0]?.id ?? "");
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 14 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [horizons, setHorizons] = useState("1, 5, 10, 20");
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialRuns.find((r) => r.status === "COMPLETED")?.id ?? null);
  const [detail, setDetail] = useState<Run | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRuns((await api<{ backtests: Run[] }>("/api/backtests")).backtests);
    } catch {
      /* transient */
    }
  }, []);

  // Poll while anything is queued/running.
  const active = runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [active, refresh]);

  const selectedRun = runs.find((r) => r.id === selected);
  // Results are keyed by run id, so a stale response never shows under another selection.
  const wantDetail = selected && selectedRun?.status === "COMPLETED" ? selected : null;
  useEffect(() => {
    if (!wantDetail) return;
    let live = true;
    api<{ backtest: Run }>(`/api/backtests/${wantDetail}`)
      .then((r) => live && setDetail(r.backtest))
      .catch((err) => toast.error(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [wantDetail]);
  const shown = detail && detail.id === wantDetail ? detail : null;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!alertId) return toast.error("Create an indicator-condition alert first.");
    const hs = horizons
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    setSubmitting(true);
    try {
      const r = await api<{ backtest: Run }>("/api/backtests", {
        method: "POST",
        body: {
          alertId,
          from: new Date(`${from}T00:00:00Z`).toISOString(),
          to: new Date(`${to}T23:59:59Z`).toISOString(),
          direction,
          horizons: hs.length ? hs : [1, 5, 10, 20],
        },
      });
      setRuns((rs) => [r.backtest, ...rs]);
      setSelected(r.backtest.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: string) {
    try {
      await api(`/api/backtests/${id}/cancel`, { method: "POST" });
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/backtests/${id}`, { method: "DELETE" });
      setRuns((rs) => rs.filter((r) => r.id !== id));
      if (selected === id) setSelected(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const alertName = (id: string | null) => alerts.find((a) => a.id === id)?.name ?? "Deleted alert";

  return (
    <div className="space-y-5">
      <Card className="p-5">
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Backtests replay indicator-condition alerts.{" "}
            <Link href="/alerts/new" className="underline">
              Create one
            </Link>{" "}
            (choose “Indicator conditions”), then come back here.
          </p>
        ) : (
          <form onSubmit={start} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Label htmlFor="bt-alert">Alert</Label>
              <Select value={alertId} onValueChange={setAlertId}>
                <SelectTrigger id="bt-alert" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {alerts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {a.symbol} {a.timeframe} · {a.dataProvider} · v{a.configVersion}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="bt-from">From (UTC)</Label>
              <Input id="bt-from" type="date" className="mt-1.5 w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="bt-to">To (UTC)</Label>
              <Input id="bt-to" type="date" className="mt-1.5 w-40" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="bt-dir">Measure moves as</Label>
              <Select value={direction} onValueChange={(d) => setDirection(d as "long" | "short")}>
                <SelectTrigger id="bt-dir" className="mt-1.5 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="long">Long (up = good)</SelectItem>
                  <SelectItem value="short">Short (down = good)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="bt-h">Forward bars</Label>
              <Input id="bt-h" className="mt-1.5 w-32 tabular" value={horizons} onChange={(e) => setHorizons(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <Play />} Run backtest
            </Button>
          </form>
        )}
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Created</TableHead>
              <TableHead>Alert</TableHead>
              <TableHead>Range</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Triggers</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No backtests yet.
                </TableCell>
              </TableRow>
            )}
            {runs.map((r) => (
              <TableRow key={r.id} className={cn("cursor-pointer", selected === r.id && "bg-muted/50")} onClick={() => setSelected(r.id)}>
                <TableCell className="tabular text-muted-foreground">{fmtTime(r.createdAt)}</TableCell>
                <TableCell className="max-w-56 truncate">
                  {alertName(r.alertId)}{" "}
                  <span className="text-xs text-muted-foreground">
                    {r.config.symbol} {r.config.timeframe}
                    {r.alertVersion ? ` · v${r.alertVersion}` : ""}
                  </span>
                </TableCell>
                <TableCell className="tabular text-xs">
                  {r.config.from.slice(0, 10)} → {r.config.to.slice(0, 10)}
                </TableCell>
                <TableCell className={cn("text-sm font-medium", STATUS_TONE[r.status])}>
                  {r.status === "RUNNING" ? `Running ${Math.round(r.progress * 100)}%` : r.status.toLowerCase()}
                  {r.error && (
                    <span className="block max-w-72 truncate text-xs font-normal text-destructive" title={r.error}>
                      {r.error}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular">{r.summary?.triggers ?? "—"}</TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  {r.status === "QUEUED" || r.status === "RUNNING" ? (
                    <Button variant="ghost" size="icon-sm" onClick={() => cancel(r.id)} aria-label="Cancel backtest">
                      <Square />
                    </Button>
                  ) : (
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(r.id)} aria-label="Delete backtest">
                      <Trash2 />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {shown && <BacktestDetail run={shown} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" title={hint}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular">{value}</div>
    </div>
  );
}

function BacktestDetail({ run }: { run: Run }) {
  const s = run.summary!;
  const [open, setOpen] = useState<number | null>(null);
  const horizons = Object.keys(s.horizons);
  return (
    <div className="space-y-5">
      {run.dataset?.synthetic && (
        <p className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-2 text-sm">
          Synthetic data (mock provider) — useful to check the logic, not a statement about real markets.
        </p>
      )}
      {s.intrabarApproximated && (
        <p className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-2 text-sm">
          This alert evaluates intrabar; history only has candles, so it was replayed at candle close.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Triggers" value={s.triggers} />
        <Stat label="Bars evaluated" value={s.barsEvaluated} hint={`${s.barsInsufficient} bars skipped for insufficient history`} />
        <Stat
          label="Bars condition true"
          value={s.conditionTrueBars}
          hint={`Suppressed: ${s.suppressed.cooldown} cooldown, ${s.suppressed.disarmed} waiting to re-arm`}
        />
        <Stat label="Avg MFE" value={fmtPct(s.avgMfePct)} hint="Maximum favourable excursion over the longest horizon" />
        <Stat label="Avg MAE" value={fmtPct(s.avgMaePct)} hint="Maximum adverse excursion over the longest horizon" />
      </div>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Forward moves after a trigger ({run.config.direction})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-4 font-medium">After</th>
                <th className="py-1 pr-4 font-medium">Samples</th>
                <th className="py-1 pr-4 font-medium">Average</th>
                <th className="py-1 pr-4 font-medium">Median</th>
                <th className="py-1 font-medium">Positive</th>
              </tr>
            </thead>
            <tbody>
              {horizons.map((h) => (
                <tr key={h} className="border-t">
                  <td className="py-1.5 pr-4">
                    {h} bar{h === "1" ? "" : "s"} ({run.config.timeframe})
                  </td>
                  <td className="py-1.5 pr-4">{s.horizons[h].n}</td>
                  <td className="py-1.5 pr-4">{fmtPct(s.horizons[h].avgPct)}</td>
                  <td className="py-1.5 pr-4">{fmtPct(s.horizons[h].medianPct)}</td>
                  <td className="py-1.5">{s.horizons[h].winRate === null ? "—" : `${s.horizons[h].winRate!.toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <BacktestChart run={run} />

      <Card className="overflow-hidden">
        <div className="border-b px-5 py-3">
          <h2 className="font-semibold">Triggers</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>#</TableHead>
              <TableHead>Candle (UTC)</TableHead>
              <TableHead className="text-right">Price</TableHead>
              {horizons.map((h) => (
                <TableHead key={h} className="text-right">
                  +{h}
                </TableHead>
              ))}
              <TableHead className="text-right">MFE</TableHead>
              <TableHead className="text-right">MAE</TableHead>
              <TableHead>
                <span className="sr-only">Why</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(run.triggers ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6 + horizons.length} className="py-8 text-center text-sm text-muted-foreground">
                  The conditions never triggered in this range.
                </TableCell>
              </TableRow>
            )}
            {(run.triggers ?? []).map((t) => (
              <Fragment key={t.n}>
                <TableRow>
                  <TableCell className="tabular text-muted-foreground">{t.n}</TableCell>
                  <TableCell className="tabular">{fmtTime(t.candleOpenTime)}</TableCell>
                  <TableCell className="text-right tabular">{t.price}</TableCell>
                  {horizons.map((h) => (
                    <TableCell
                      key={h}
                      className={cn("text-right tabular", (t.forward[h] ?? 0) > 0 ? "text-up" : (t.forward[h] ?? 0) < 0 ? "text-down" : "")}
                    >
                      {fmtPct(t.forward[h])}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular">{fmtPct(t.mfePct)}</TableCell>
                  <TableCell className="text-right tabular">{fmtPct(t.maePct)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setOpen(open === t.n ? null : t.n)} aria-expanded={open === t.n}>
                      Why? <ChevronDown className={cn("transition-transform", open === t.n && "rotate-180")} />
                    </Button>
                  </TableCell>
                </TableRow>
                {open === t.n && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={6 + horizons.length} className="whitespace-normal">
                      <p className="mb-2 text-xs text-muted-foreground">{t.values}</p>
                      {t.tree ? <EvaluationTree node={t.tree} /> : <p className="text-sm">{t.reason}</p>}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-5 text-xs text-muted-foreground">
        <h2 className="mb-2 text-sm font-semibold text-foreground">Reproducibility</h2>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[160px_1fr]">
          <dt>Engines</dt>
          <dd>
            {Object.entries(run.engineVersions)
              .map(([k, v]) => `${k} ${v}`)
              .join(" · ")}
          </dd>
          <dt>Alert version</dt>
          <dd>{run.alertVersion ? `v${run.alertVersion}` : "—"}</dd>
          <dt>Dataset SHA-256</dt>
          <dd className="break-all font-mono">{run.dataset?.sha256 ?? "—"}</dd>
          {Object.entries(run.dataset?.timeframes ?? {}).map(([tf, d]) => (
            <Fragment key={tf}>
              <dt>{tf} candles</dt>
              <dd>
                {d.candles} from {d.source}
                {d.first && ` · ${d.first.slice(0, 16)} → ${d.last?.slice(0, 16)} UTC`}
                {d.issues ? ` · ${d.issues} data issue(s)` : ""}
              </dd>
            </Fragment>
          ))}
        </dl>
      </Card>
    </div>
  );
}
