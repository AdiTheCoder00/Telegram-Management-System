import { route } from "@/lib/api";
import { revokeOtherSessions } from "@/lib/services/auth";

/** Signs out every session except the current one. */
export const POST = route(async ({ user }) => revokeOtherSessions(user.id, user.sessionId));
