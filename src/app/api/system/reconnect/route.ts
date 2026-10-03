import { clientIp, route } from "@/lib/api";
import { reconnectMarketData } from "@/lib/services/operations";

export const POST = route(async ({ req, user }) => reconnectMarketData(user.id, clientIp(req)), {
  rateLimit: [10, 60_000],
  bucket: "system-reconnect",
});
