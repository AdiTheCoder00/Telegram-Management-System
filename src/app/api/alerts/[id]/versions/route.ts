import { route } from "@/lib/api";
import { listAlertVersions } from "@/lib/services/alerts";

/** Immutable configuration history of an alert (newest first). */
export const GET = route<{ id: string }>(async ({ user, params }) => ({ versions: await listAlertVersions(user.id, params.id) }));
