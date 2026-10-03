import Link from "next/link";
import { Plus } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { listAlerts } from "@/lib/services/alerts";
import { listBots } from "@/lib/services/bots";
import { alertListQuerySchema } from "@/lib/validation";
import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { AlertsTable } from "@/components/alerts/alerts-table";
import { ImportExport } from "@/components/alerts/bulk-bar";
import { listGroups } from "@/lib/services/alert-bulk";

export const metadata = { title: "Alerts" };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = (await getCurrentUser())!;
  const sp = await searchParams;
  const parsed = alertListQuerySchema.safeParse(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)));
  const q = parsed.success ? parsed.data : {};
  const [alerts, bots, all, groups] = await Promise.all([
    listAlerts(user.id, q),
    listBots(user.id),
    listAlerts(user.id, {}).then((a) => [...new Set(a.map((x) => x.symbol))].sort()),
    listGroups(user.id),
  ]);

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Every alert you've set up. Pause one with its status toggle, or use the menu to test, duplicate or delete it."
        actions={
          <>
            <ImportExport />
            <Button asChild>
              <Link href="/alerts/new">
                <Plus /> Create Alert
              </Link>
            </Button>
          </>
        }
      />
      <AlertsTable alerts={alerts} bots={bots.map((b) => ({ id: b.id, name: b.name }))} symbols={all} filters={q} groups={groups} />
    </>
  );
}
