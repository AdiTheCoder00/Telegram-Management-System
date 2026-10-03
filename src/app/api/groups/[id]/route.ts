import { route } from "@/lib/api";
import { deleteGroup } from "@/lib/services/alert-bulk";

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await deleteGroup(user.id, params.id);
  return { ok: true };
});
