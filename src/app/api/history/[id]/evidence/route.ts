import { route } from "@/lib/api";
import { getEventEvidence } from "@/lib/services/history";

/** "Why did this alert trigger?" — immutable evidence for one history event. */
export const GET = route<{ id: string }>(async ({ user, params }) => getEventEvidence(user.id, params.id));
