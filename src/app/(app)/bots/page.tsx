import { getCurrentUser } from "@/lib/auth/session";
import { listBots } from "@/lib/services/bots";
import { PageHeader } from "@/components/app-shell";
import { BotsManager } from "@/components/bots/bots-manager";

export const metadata = { title: "Telegram bots" };

export default async function BotsPage() {
  const user = (await getCurrentUser())!;
  const bots = await listBots(user.id);
  return (
    <>
      <PageHeader
        title="Telegram bots"
        description="Each bot sends to one chat, group or channel. Tokens are encrypted and never shown again after you save them."
      />
      <BotsManager bots={JSON.parse(JSON.stringify(bots))} />
    </>
  );
}
