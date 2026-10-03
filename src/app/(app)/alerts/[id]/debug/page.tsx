import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/app-shell";
import { AlertStatusBadge } from "@/components/status";
import { Card } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { getOwnedAlert } from "@/lib/services/alerts";
import { AlertDebugger } from "./alert-debugger";

export const metadata = { title: "Debug alert" };

export default async function DebugAlertPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser())!;
  const { id } = await params;
  const alert = await getOwnedAlert(user.id, id).catch(() => null);
  if (!alert) notFound();

  return (
    <>
      <PageHeader
        title={`Debug ${alert.name}`}
        description="Runs this alert through the live engine at any moment and shows every step. Nothing is saved or sent."
        actions={
          <>
            <AlertStatusBadge status={alert.status} />
            <Button asChild variant="outline" size="sm">
              <Link href={`/alerts/${alert.id}/edit`}>Edit alert</Link>
            </Button>
          </>
        }
      />
      <Card className="p-5">
        {alert.kind === "CONDITIONS" ? (
          <>
            <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Symbol</dt>
                <dd className="font-medium">{alert.symbol}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Timeframe · mode</dt>
                <dd>
                  {alert.timeframe} · {alert.evaluationMode === "CANDLE_CLOSE" ? "candle close" : "intrabar"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Market data</dt>
                <dd>{alert.marketDataState ?? "not evaluated yet"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Version</dt>
                <dd>v{alert.configVersion}</dd>
              </div>
            </dl>
            {alert.lastEvaluationNote && <p className="mb-4 text-sm text-muted-foreground">{alert.lastEvaluationNote}</p>}
            <AlertDebugger alertId={alert.id} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            The debugger is for indicator-condition alerts. Price-level alerts can be tested with “Simulate price” on the Alerts page.
          </p>
        )}
      </Card>
    </>
  );
}
