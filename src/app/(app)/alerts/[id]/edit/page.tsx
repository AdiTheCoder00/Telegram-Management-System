import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/app-shell";
import { AlertForm } from "@/components/alerts/alert-form";
import { loadAlertFormData, valuesFromAlert } from "@/lib/services/form-data";
import { getOwnedAlert, serializeAlert } from "@/lib/services/alerts";
import { AlertStatusBadge } from "@/components/status";

export const metadata = { title: "Edit alert" };

export default async function EditAlertPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await getCurrentUser())!;
  const { id } = await params;
  const alert = await getOwnedAlert(user.id, id).catch(() => null);
  if (!alert) notFound();
  const dto = serializeAlert(alert);
  const data = await loadAlertFormData(user.id);

  return (
    <>
      <PageHeader
        title={`Edit ${dto.name}`}
        description="Changing the symbol, condition or target re-arms the alert."
        actions={<AlertStatusBadge status={dto.status} />}
      />
      {dto.lastError && (
        <p className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{dto.lastError}</p>
      )}
      <AlertForm mode="edit" alertId={dto.id} initial={valuesFromAlert(dto)} timezone={user.timezone} {...data} />
    </>
  );
}
