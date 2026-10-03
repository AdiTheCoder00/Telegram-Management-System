import { route, parseBody } from "@/lib/api";
import { changePasswordSchema } from "@/lib/validation";
import { changePassword } from "@/lib/services/auth";

/** POST { currentPassword, newPassword } — signs out all other sessions. */
export const POST = route(
  async ({ req, user }) => {
    const input = await parseBody(req, changePasswordSchema);
    return changePassword(user.id, user.sessionId, input.currentPassword, input.newPassword);
  },
  { rateLimit: [5, 15 * 60_000], bucket: "password" },
);
