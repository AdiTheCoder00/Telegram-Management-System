import Link from "next/link";
import type { Analytics } from "@/lib/services/analytics";
import { cn } from "@/lib/utils";

const ms = (x: number | null) => (x === null ? "—" : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);

function Bars({ data, label, height = 120 }: { data: { key: string; n: number; title: string }[]; label: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height }} role="img" aria-label={label}>
        {data.map((d) => (
          <div key={d.key} className="group relative flex-1" style={{ height: "100%" }} title={d.title}>
            <div
              className={cn("absolute inset-x-0 bottom-0 rounded-t-sm", d.n ? "bg-signal" : "bg-muted")}
              style={{ height: `${d.n ? Math.max(4, (d.n / max) * 100) : 2}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function AnalyticsView({ a }: { a: Analytics }) {
  const maxAlert = Math.max(1, ...a.byAlert.map((x) => x.n));
  return (
    <div className="space-y-6 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Triggers (last ${a.days} days)`} value={a.totals.triggers} hint={`${a.totals.perDayAvg} per day on average`} />
        <Stat
          label="Telegram delivery success"
          value={a.delivery.successRate === null ? "—" : `${a.delivery.successRate}%`}
          hint={`${a.delivery.byStatus.SENT ?? 0} sent · ${(a.delivery.byStatus.FAILED ?? 0) + (a.delivery.byStatus.DEAD_LETTER ?? 0)} failed`}
        />
        <Stat
          label="Trigger → Telegram (median)"
          value={ms(a.delivery.latencyMs.p50)}
          hint={`95th percentile ${ms(a.delivery.latencyMs.p95)}`}
        />
        <Stat
          label="Waiting / retrying"
          value={(a.delivery.byStatus.QUEUED ?? 0) + (a.delivery.byStatus.RETRYING ?? 0) + (a.delivery.byStatus.SENDING ?? 0)}
          hint="Notifications not yet delivered"
        />
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Triggers per day</h3>
        <Bars label="Triggers per day" data={a.perDay.map((d) => ({ key: d.day, n: d.n, title: `${d.day}: ${d.n}` }))} />
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular">
          <span>{a.perDay[0]?.day}</span>
          <span>{a.perDay.at(-1)?.day}</span>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-sm font-semibold">Time of day ({a.timezone})</h3>
          <Bars
            label="Triggers by hour"
            height={90}
            data={a.perHour.map((h) => ({ key: String(h.hour), n: h.n, title: `${String(h.hour).padStart(2, "0")}:00 — ${h.n}` }))}
          />
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold">Busiest symbols</h3>
          {a.bySymbol.length === 0 ? (
            <p className="text-sm text-muted-foreground">No triggers yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {a.bySymbol.map((s) => (
                <li key={s.symbol} className="flex justify-between tabular">
                  <span className="font-medium">{s.symbol}</span>
                  <span>{s.n}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Most active alerts</h3>
        {a.byAlert.length === 0 ? (
          <p className="text-sm text-muted-foreground">No triggers in this period.</p>
        ) : (
          <ul className="space-y-1.5">
            {a.byAlert.map((x) => (
              <li key={x.alertId ?? x.name} className="grid grid-cols-[minmax(0,14rem)_1fr_3rem] items-center gap-3 text-sm">
                {x.alertId ? (
                  <Link href={`/alerts/${x.alertId}/edit`} className="truncate hover:underline">
                    {x.name}
                  </Link>
                ) : (
                  <span className="truncate text-muted-foreground">{x.name} (deleted)</span>
                )}
                <div className="h-2 rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-signal" style={{ width: `${(x.n / maxAlert) * 100}%` }} />
                </div>
                <span className="text-right tabular">{x.n}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          An alert that fires far more than the others may need a cooldown or the re-arm mode.
        </p>
      </section>

      {a.marketData.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Live indicator alerts by data state</h3>
          <div className="flex flex-wrap gap-2 text-sm">
            {a.marketData.map((m) => (
              <span key={m.state} className="rounded-full border px-3 py-1">
                {m.state.toLowerCase().replace(/_/g, " ")} · {m.n}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
