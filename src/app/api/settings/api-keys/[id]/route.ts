import { route } from "@/lib/api";
import { revokeApiKey } from "@/lib/services/api-keys";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await revokeApiKey(user.id, params.id);
  return { ok: true };
});
