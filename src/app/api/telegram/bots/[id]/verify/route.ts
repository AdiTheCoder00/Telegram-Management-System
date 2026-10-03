import { route } from "@/lib/api";
import { verifyBot } from "@/lib/services/bots";

export const POST = route<{ id: string }>(async ({ user, params }) => ({ bot: await verifyBot(user.id, params.id) }), {
  rateLimit: [20, 60_000],
  bucket: "bot-verify",
});
