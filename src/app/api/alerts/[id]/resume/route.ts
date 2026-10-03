import { route } from "@/lib/api";
import { resumeAlert } from "@/lib/services/alerts";

export const POST = route<{ id: string }>(async ({ user, params }) => ({ alert: await resumeAlert(user.id, params.id) }));
