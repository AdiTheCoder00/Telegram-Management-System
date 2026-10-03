import { getCurrentUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/app-shell";
import { AutoRefresh } from "@/components/auto-refresh";
import { SystemView } from "@/components/system/system-view";
import { systemStatus } from "@/lib/services/operations";

export const metadata = { title: "System" };

export default async function SystemPage() {
  const user = (await getCurrentUser())!;
  const status = await systemStatus(user.id);
  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        title="System"
        description="Health of every moving part, what is queued, and the emergency controls. Every action here is audited."
      />
      <SystemView status={JSON.parse(JSON.stringify(status))} />
    </>
  );
}
