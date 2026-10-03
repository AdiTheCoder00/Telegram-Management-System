import { route, parseBody } from "@/lib/api";
import { alertInputSchema } from "@/lib/validation";
import { deleteAlert, getOwnedAlert, serializeAlert, updateAlert } from "@/lib/services/alerts";
import { latestQuote } from "@/lib/engine/quotes";

type P = { id: string };

export const GET = route<P>(async ({ user, params }) => {
  const alert = await getOwnedAlert(user.id, params.id);
  const quote = await latestQuote(alert.dataProvider, alert.symbol, user.id);
  return { alert: serializeAlert(alert, quote?.price) };
});

export const PUT = route<P>(async ({ req, user, params }) => {
  const input = await parseBody(req, alertInputSchema);
  return { alert: await updateAlert(user.id, params.id, input) };
});

export const DELETE = route<P>(async ({ user, params }) => {
  await deleteAlert(user.id, params.id);
  return { ok: true };
});
