import { route, parseBody } from "@/lib/api";
import { updateBotSchema } from "@/lib/validation";
import { deleteBot, getOwnedBot, serializeBot, updateBot } from "@/lib/services/bots";

type P = { id: string };

export const GET = route<P>(async ({ user, params }) => ({ bot: serializeBot(await getOwnedBot(user.id, params.id)) }));

export const PUT = route<P>(async ({ req, user, params }) => {
  const input = await parseBody(req, updateBotSchema);
  return { bot: await updateBot(user.id, params.id, input) };
});

export const DELETE = route<P>(async ({ user, params }) => deleteBot(user.id, params.id));
