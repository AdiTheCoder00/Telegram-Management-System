import { clientIp, route } from "@/lib/api";
import { retryFailedNotifications } from "@/lib/services/operations";

export const POST = route(async ({ req, user }) => retryFailedNotifications(user.id, clientIp(req)), {
  rateLimit: [10, 60_000],
  bucket: "system-retry-notifications",
});
