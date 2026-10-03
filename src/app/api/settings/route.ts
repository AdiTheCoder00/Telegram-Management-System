import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { settingsSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";

export const GET = route(async ({ user }) => ({ user: { id: user.id, email: user.email, name: user.name, timezone: user.timezone } }));

export const PUT = route(async ({ req, user }) => {
  const input = await parseBody(req, settingsSchema);
  if (input.email && input.email !== user.email) {
    const taken = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (taken)
      throw new AppError(409, "That email is already used by another account.", "email_taken", {
        fieldErrors: { email: "Already in use." },
      });
  }
  const updated = await db.user.update({
    where: { id: user.id },
    data: input,
    select: { id: true, email: true, name: true, timezone: true },
  });
  return { user: updated };
});
