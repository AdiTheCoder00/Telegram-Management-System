import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { settingsSchema } from "@/lib/validation";

export const GET = route(async ({ user }) => ({ user }));

export const PUT = route(async ({ req, user }) => {
  const input = await parseBody(req, settingsSchema);
  const updated = await db.user.update({
    where: { id: user.id },
    data: input,
    select: { id: true, email: true, name: true, timezone: true },
  });
  return { user: updated };
});
