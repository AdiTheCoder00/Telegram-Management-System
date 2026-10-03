import { route, parseBody } from "@/lib/api";
import { importAlerts, importSchema } from "@/lib/services/alert-bulk";

/** POST /api/alerts/import — all-or-nothing import of an export file; alerts start paused. */
export const POST = route(async ({ req, user }) => importAlerts(user.id, await parseBody(req, importSchema)), {
  rateLimit: [10, 60_000],
  bucket: "alerts-import",
});
