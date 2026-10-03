import { route } from "@/lib/api";
import { systemStatus } from "@/lib/services/operations";

/** GET /api/system — health, provider health, queues, bulk-pause state and the audit log. */
export const GET = route(async ({ user }) => systemStatus(user.id));
