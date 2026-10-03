import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { deleteWebhook, setWebhookEnabled } from "@/lib/services/webhooks";

type P = { id: string };

export const PATCH = route<P>(async ({ req, user, params }) => {
  const { enabled } = await parseBody(req, z.object({ enabled: z.boolean() }));
  return { webhook: await setWebhookEnabled(user.id, params.id, enabled) };
});

export const DELETE = route<P>(async ({ user, params }) => {
  await deleteWebhook(user.id, params.id);
  return { ok: true };
});
