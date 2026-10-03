import { clientIp, route } from "@/lib/api";
import { pauseAll } from "@/lib/services/operations";

export const POST = route(async ({ req, user }) => pauseAll(user.id, clientIp(req)), {
  rateLimit: [10, 60_000],
  bucket: "system-pause-all",
});
