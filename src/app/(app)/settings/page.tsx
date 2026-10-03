import { getCurrentUser } from "@/lib/auth/session";
import { listApiKeys } from "@/lib/services/api-keys";
import { PageHeader } from "@/components/app-shell";
import { SettingsView } from "@/components/settings/settings-view";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = (await getCurrentUser())!;
  const keys = await listApiKeys(user.id);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, timezone and the keys that let other services send prices to Levels." />
      <SettingsView user={user} keys={JSON.parse(JSON.stringify(keys))} appUrl={process.env.APP_URL ?? ""} />
    </>
  );
}
