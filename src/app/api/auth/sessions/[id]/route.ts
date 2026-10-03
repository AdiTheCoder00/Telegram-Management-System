import { route } from "@/lib/api";
import { revokeSession } from "@/lib/services/auth";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await revokeSession(user.id, params.id);
  return { ok: true };
});
