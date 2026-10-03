import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboard } from "@/lib/services/dashboard";
import { QUICK_TEMPLATES, type QuickTemplateKey } from "@/lib/services/form-data";
import { PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertStatusBadge, AlertConditionCell, DeliveryBadge, RelativeTime } from "@/components/status";
import { AutoRefresh } from "@/components/auto-refresh";
import { LiveMonitor } from "@/components/monitor/live-monitor";
import { cn, formatPrice } from "@/lib/utils";

export const metadata = { title: "Dashboard" };

const TEMPLATE_META: Record<QuickTemplateKey, { icon: typeof ArrowUpRight; tone: string; hint: string }> = {
  above: { icon: ArrowUpRight, tone: "text-up", hint: "Price at or above a level" },
  below: { icon: ArrowDownRight, tone: "text-down", hint: "Price at or below a level" },
  breakout: { icon: TrendingUp, tone: "text-up", hint: "Price crosses up through resistance" },
  breakdown: { icon: TrendingDown, tone: "text-down", hint: "Price crosses down through support" },
};

const TG_STATUS = {
  CONNECTED: { label: "Connected", dot: "bg-up", text: "text-up" },
  DISCONNECTED: { label: "Disconnected", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  ERROR: { label: "Error", dot: "bg-down", text: "text-down" },
} as const;

export default async function DashboardPage() {
  const user = (await getCurrentUser())!;
  const d = await getDashboard(user.id, user.timezone);
  const tg = TG_STATUS[d.telegram.status];
  const firstName = user.name?.split(" ")[0];

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title={firstName ? `Hello, ${firstName}` : "Dashboard"}
        description={
          d.stats.active
            ? `${d.stats.active} alert${d.stats.active === 1 ? " is" : "s are"} watching the market right now.`
            : "No alerts are watching the market yet."
        }
      />

      {/* One segmented strip instead of four separate cards */}
      <Card className="grid grid-cols-2 divide-border overflow-hidden lg:grid-cols-4 lg:divide-x [&>*]:border-border max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*:nth-child(odd)]:border-r">
        <Stat label="Total alerts" value={d.stats.total} href="/alerts" />
        <Stat label="Active alerts" value={d.stats.active} href="/alerts?status=ACTIVE" />
        <Stat label="Triggered today" value={d.stats.triggeredToday} href="/history" accent={d.stats.triggeredToday > 0} />
        <Link href="/bots" className="group px-5 py-4 transition-colors hover:bg-muted/40">
          <div className="text-sm text-muted-foreground">Telegram status</div>
          <div className={cn("mt-1 flex items-center gap-2 text-[22px] leading-tight font-semibold", tg.text)}>
            <span className={cn("size-2.5 rounded-full", tg.dot)} />
            {tg.label}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {d.telegram.bots === 0
              ? d.telegram.disabled
                ? `All ${d.telegram.disabled} bot${d.telegram.disabled === 1 ? " is" : "s are"} disabled`
                : "Add a bot to receive alerts"
              : (d.telegram.error ?? `${d.telegram.connected} of ${d.telegram.bots} bot${d.telegram.bots === 1 ? "" : "s"} connected`)}
          </div>
        </Link>
      </Card>

      <LiveMonitor />

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", d.engine.online ? "bg-up" : "bg-down")} />
          {d.engine.online ? "Alert engine running" : "Alert engine offline — start the worker with npm run worker"}
        </span>
        {d.stats.failed24h > 0 && (
          <Link href="/history?status=FAILED" className="text-destructive underline-offset-2 hover:underline">
            {d.stats.failed24h} failed deliver{d.stats.failed24h === 1 ? "y" : "ies"} in the last 24h
          </Link>
        )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          {/* Quick add */}
          <section className="overflow-hidden rounded-xl bg-sidebar text-white">
            <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Watch a new level</h2>
                <p className="mt-1 text-sm text-sidebar-foreground">Pick a starting point, or build an alert from scratch.</p>
              </div>
              <Button asChild size="lg" className="shrink-0 text-base">
                <Link href="/alerts/new">
                  <Plus className="size-5" /> Create Alert
                </Link>
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-px border-t border-white/10 bg-white/10 md:grid-cols-4">
              {(Object.keys(QUICK_TEMPLATES) as QuickTemplateKey[]).map((k) => {
                const meta = TEMPLATE_META[k];
                const Icon = meta.icon;
                return (
                  <Link
                    key={k}
                    href={`/alerts/new?template=${k}`}
                    className="group bg-sidebar px-5 py-4 transition-colors hover:bg-sidebar-active"
                  >
                    <Icon className={cn("size-5", meta.tone === "text-up" ? "text-[#2bb8a3]" : "text-[#e25c73]")} />
                    <div className="mt-2 text-sm font-medium">{QUICK_TEMPLATES[k].label}</div>
                    <div className="mt-0.5 text-xs text-sidebar-foreground">{meta.hint}</div>
                  </Link>
                );
              })}
            </div>
          </section>

          {/* Recent alerts */}
          <Card>
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
              <h2 className="font-semibold">Recent alerts</h2>
              <Link href="/alerts" className="text-sm text-muted-foreground hover:text-foreground">
                View all
              </Link>
            </div>
            {d.recentAlerts.length === 0 ? (
              <p className="border-t px-5 py-10 text-center text-sm text-muted-foreground">Your alerts will appear here.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Symbol</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead className="text-right">Target</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last triggered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.recentAlerts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link href={`/alerts/${a.id}/edit`} className="font-semibold hover:underline">
                          {a.symbol}
                        </Link>
                        <div className="max-w-44 truncate text-xs text-muted-foreground">{a.name}</div>
                      </TableCell>
                      <TableCell>
                        <AlertConditionCell alert={a} />
                      </TableCell>
                      <TableCell className="text-right font-medium tabular">
                        {a.kind === "CONDITIONS" ? "—" : formatPrice(a.targetPrice)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular">{formatPrice(a.currentPrice)}</TableCell>
                      <TableCell>
                        <AlertStatusBadge status={a.status} />
                      </TableCell>
                      <TableCell>
                        <RelativeTime date={a.lastTriggeredAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>

        {/* Recent triggers */}
        <Card className="self-start">
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <h2 className="font-semibold">Latest triggers</h2>
            <Link href="/history" className="text-sm text-muted-foreground hover:text-foreground">
              History
            </Link>
          </div>
          {d.recentEvents.length === 0 ? (
            <p className="border-t px-5 py-10 text-center text-sm text-muted-foreground">When an alert fires, it shows up here.</p>
          ) : (
            <ol className="divide-y border-t">
              {d.recentEvents.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {e.isTest && (
                        <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground">Test</span>
                      )}
                      {e.alertName}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {e.symbol} at <span className="tabular">{formatPrice(e.triggerPrice)}</span> · <RelativeTime date={e.triggeredAt} />
                    </div>
                  </div>
                  <DeliveryBadge status={e.status} />
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, href, accent }: { label: string; value: number; href: string; accent?: boolean }) {
  return (
    <Link href={href} className="px-5 py-4 transition-colors hover:bg-muted/40">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div
        className={cn("mt-1 text-[30px] leading-none font-semibold tracking-tight tabular", accent && "text-[#b07a00] dark:text-signal")}
      >
        {value}
      </div>
    </Link>
  );
}
