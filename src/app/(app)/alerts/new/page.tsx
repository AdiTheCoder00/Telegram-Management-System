import { getCurrentUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/app-shell";
import { AlertForm } from "@/components/alerts/alert-form";
import { blankValues, loadAlertFormData, valuesFromAlert } from "@/lib/services/form-data";
import { getOwnedAlert, serializeAlert } from "@/lib/services/alerts";

export const metadata = { title: "Add alert" };

export default async function NewAlertPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = (await getCurrentUser())!;
  const sp = await searchParams;
  const data = await loadAlertFormData(user.id);
  const defaultBot = data.bots.find((b) => b.status === "CONNECTED") ?? data.bots[0];

  let initial = blankValues(defaultBot?.id ?? null, sp.template, sp.symbol?.toUpperCase());
  let duplicating = false;
  if (sp.from) {
    try {
      const source = await getOwnedAlert(user.id, sp.from);
      initial = valuesFromAlert(serializeAlert(source), { duplicate: true });
      duplicating = true;
    } catch {
      /* not found / not owned → start blank */
    }
  }

  return (
    <>
      <PageHeader
        title={duplicating ? "Duplicate alert" : "Add alert"}
        description={
          duplicating
            ? "A copy of your alert — change what you need, then save it as a new alert."
            : "Pick a symbol and a level. You'll get one Telegram message when it's reached."
        }
      />
      <AlertForm mode="create" initial={initial} timezone={user.timezone} {...data} />
    </>
  );
}
