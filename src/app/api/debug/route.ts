import { route, parseBody } from "@/lib/api";
import { debugConditions, debugInputSchema } from "@/lib/services/debugger";

/** POST /api/debug — dry-run a condition alert (or an unsaved configuration) through the live engine. Writes nothing. */
export const POST = route(async ({ req, user }) => debugConditions(user.id, await parseBody(req, debugInputSchema)), {
  rateLimit: [60, 60_000],
  bucket: "debug",
});
