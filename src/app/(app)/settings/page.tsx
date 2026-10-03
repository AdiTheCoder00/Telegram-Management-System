import { getCurrentUser } from "@/lib/auth/session";
import { listApiKeys } from "@/lib/services/api-keys";
import { listWebhooks } from "@/lib/services/webhooks";
import { PageHeader } from "@/components/app-shell";
import { SettingsView } from "@/components/settings/settings-view";
import { LOCAL_SESSION_ID } from "@/lib/auth/constants";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = (await getCurrentUser())!;
  const [keys, webhooks] = await Promise.all([listApiKeys(user.id), listWebhooks(user.id)]);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, timezone and the keys that let other services send prices to Levels." />
      <SettingsView
        user={{ name: user.name, email: user.email, timezone: user.timezone }}
        localMode={user.sessionId === LOCAL_SESSION_ID}
        keys={JSON.parse(JSON.stringify(keys))}
        webhooks={JSON.parse(JSON.stringify(webhooks))}
        appUrl={process.env.APP_URL ?? ""}
      />
    </>
  );
}
