import { route, parseBody } from "@/lib/api";
import { bulkAction, bulkSchema } from "@/lib/services/alert-bulk";

/** POST /api/alerts/bulk — pause / resume / delete / move-to-group for many alerts; per-alert results. */
export const POST = route(async ({ req, user }) => bulkAction(user.id, await parseBody(req, bulkSchema)), {
  rateLimit: [30, 60_000],
  bucket: "alerts-bulk",
});
