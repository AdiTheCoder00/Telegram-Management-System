import { clientIp, route } from "@/lib/api";
import { resumeAll } from "@/lib/services/operations";

export const POST = route(async ({ req, user }) => resumeAll(user.id, clientIp(req)), {
  rateLimit: [10, 60_000],
  bucket: "system-resume-all",
});
