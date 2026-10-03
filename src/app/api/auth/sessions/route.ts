import { route } from "@/lib/api";
import { listSessions } from "@/lib/services/auth";

/** Active sessions (devices) for the signed-in user; `current` marks this browser. */
export const GET = route(async ({ user }) => ({ sessions: await listSessions(user.id, user.sessionId) }));
