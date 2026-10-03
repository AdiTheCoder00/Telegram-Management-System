import { route } from "@/lib/api";
import { pauseAlert } from "@/lib/services/alerts";

export const POST = route<{ id: string }>(async ({ user, params }) => ({ alert: await pauseAlert(user.id, params.id) }));
