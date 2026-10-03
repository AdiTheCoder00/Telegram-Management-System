import { route } from "@/lib/api";
import { sendTestAlert } from "@/lib/services/alerts";

export const POST = route<{ id: string }>(async ({ user, params }) => ({ result: await sendTestAlert(user.id, params.id) }), {
  rateLimit: [10, 60_000],
  bucket: "alert-test",
});
