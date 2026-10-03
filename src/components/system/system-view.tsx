"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Pause, Play, PlugZap, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/dialog";
import { RelativeTime } from "@/components/status";
import { api, errorMessage } from "@/lib/client-api";
import type { SystemStatus } from "@/lib/services/operations";
import { cn } from "@/lib/utils";

type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

const TONE: Record<string, string> = {
  CONNECTED: "text-up",
  RUNNING: "text-up",
  OK: "text-up",
  SIMULATED: "text-signal",
  NOT_CONFIGURED: "text-muted-foreground",
  DEGRADED: "text-signal",
  STALE: "text-signal",
  DISCONNECTED: "text-down",
  STOPPED: "text-down",
  ERROR: "text-down",
  DOWN: "text-down",
};

const LABELS: Record<string, string> = { database: "Database", redis: "Queue (Redis)", marketData: "Market data", workers: "Worker" };

export function SystemView({ status }: { status: Json<SystemStatus> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);

  async function act(path: string, done: (r: Record<string, unknown>) => string) {
    setBusy(path);
    try {
      const r = await api<Record<string, unknown>>(`/api/system/${path}`, { method: "POST" });
      toast.success(done(r));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const d = status.queues.deliveries;
  const failedCount = (d.FAILED ?? 0) + (d.DEAD_LETTER ?? 0);

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <span className={cn("text-lg font-semibold", TONE[status.health.status])}>{status.health.status}</span>
          <span className="text-sm text-muted-foreground">overall</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(status.health.checks).map(([k, c]) => (
            <div key={k} className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">{LABELS[k] ?? k}</div>
              <div className={cn("mt-0.5 font-semibold", TONE[c.status as string])}>
                {(c.status as string).replace("_", " ").toLowerCase()}
              </div>
              {typeof c.latencyMs === "number" && <div className="text-xs text-muted-foreground tabular">{c.latencyMs} ms</div>}
              {typeof c.detail === "string" && <div className="mt-1 text-xs text-muted-foreground">{c.detail}</div>}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Emergency controls</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {status.alerts.live} live alert{status.alerts.live === 1 ? "" : "s"}
          {status.alerts.pausedByBulk ? ` · ${status.alerts.pausedByBulk} paused by “Pause all”` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setConfirmPause(true)} disabled={!!busy || status.alerts.live === 0}>
            {busy === "pause-all" ? <Loader2 className="animate-spin" /> : <Pause />} Pause all alerts
          </Button>
          <Button
            variant="outline"
            disabled={!!busy || status.alerts.pausedByBulk === 0}
            onClick={() =>
              act("resume-all", (r) => {
                const failed = r.failed as { name: string; error: string }[];
                return `Resumed ${r.resumed}${failed.length ? ` · ${failed.length} could not resume (${failed[0].name}: ${failed[0].error})` : ""}`;
              })
            }
          >
            {busy === "resume-all" ? <Loader2 className="animate-spin" /> : <Play />} Resume all
          </Button>
          <Button
            variant="outline"
            disabled={!!busy}
            onClick={() => act("reconnect", () => "Market data reconnected — one poll cycle ran now.")}
          >
            {busy === "reconnect" ? <Loader2 className="animate-spin" /> : <PlugZap />} Reconnect market data
          </Button>
          <Button
            variant="outline"
            disabled={!!busy || failedCount === 0}
            onClick={() => act("retry-notifications", (r) => `Re-queued ${r.requeued} notification(s).`)}
          >
            {busy === "retry-notifications" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry failed notifications (
            {failedCount})
          </Button>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Market data providers</h2>
          <ul className="divide-y text-sm">
            {status.providers.map((p) => (
              <li key={p.key} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{p.label}</span>
                  <span
                    className={cn(
                      "text-xs",
                      p.synthetic
                        ? "text-signal"
                        : !p.configured
                          ? "text-muted-foreground"
                          : p.consecutiveFailures
                            ? "text-down"
                            : p.lastSuccessAt
                              ? "text-up"
                              : "text-muted-foreground",
                    )}
                  >
                    {p.synthetic
                      ? "synthetic"
                      : !p.configured
                        ? "not configured"
                        : p.consecutiveFailures
                          ? `${p.consecutiveFailures} failure(s)`
                          : p.lastSuccessAt
                            ? "ok"
                            : "idle (no data yet)"}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {p.realtime} · candles:{" "}
                  {p.candleTimeframes.length
                    ? p.candleTimeframes.join(" ")
                    : p.realtime === "push"
                      ? "pushed bars or built from ticks"
                      : "built from ticks"}{" "}
                  · volume: {p.volume.toLowerCase()}
                </div>
                <div className="text-xs text-muted-foreground">
                  last success <RelativeTime date={p.lastSuccessAt} fallback="never" />
                  {p.lastError && (
                    <span className="text-down">
                      {" "}
                      · last error <RelativeTime date={p.lastErrorAt} />: {p.lastError}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Queues</h2>
          <p className="mb-2 text-xs text-muted-foreground">Mode: {status.queues.mode}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm tabular">
            {["QUEUED", "SENDING", "RETRYING", "SENT", "FAILED", "DEAD_LETTER"].map((s) => (
              <div key={s} className="contents">
                <dt className="text-muted-foreground">Notifications {s.toLowerCase().replace("_", " ")}</dt>
                <dd className={cn(s === "DEAD_LETTER" && (d[s] ?? 0) > 0 && "text-down")}>{d[s] ?? 0}</dd>
              </div>
            ))}
          </dl>
          {status.queues.oldestPending && (
            <p className="mt-2 text-xs text-signal">
              Oldest pending notification: {status.queues.oldestPending.ageSec}s old ({status.queues.oldestPending.status.toLowerCase()},{" "}
              {status.queues.oldestPending.attempts} attempts)
              {status.queues.oldestPending.error ? ` — ${status.queues.oldestPending.error}` : ""}
            </p>
          )}
          <h3 className="mt-4 mb-1 text-sm font-medium">Backtests</h3>
          <p className="text-sm text-muted-foreground tabular">
            {Object.keys(status.queues.backtests).length
              ? Object.entries(status.queues.backtests)
                  .map(([k, v]) => `${k.toLowerCase()} ${v}`)
                  .join(" · ")
              : "none"}
          </p>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Audit log</h2>
        {status.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No operational actions yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {status.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span className="font-mono text-xs">{a.action}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{a.detail ? JSON.stringify(a.detail) : ""}</span>
                <RelativeTime date={a.createdAt} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title="Pause every live alert?"
        description="Nothing will be evaluated or sent until you resume. “Resume all” restores exactly the alerts paused here."
        confirmLabel="Pause all"
        onConfirm={() => act("pause-all", (r) => `Paused ${r.paused} alert(s).`)}
      />
    </div>
  );
}
