import { route } from "@/lib/api";
import { deleteBacktest, getBacktest } from "@/lib/services/backtests";

type P = { id: string };

export const GET = route<P>(async ({ user, params }) => ({ backtest: await getBacktest(user.id, params.id) }));

export const DELETE = route<P>(async ({ user, params }) => {
  await deleteBacktest(user.id, params.id);
  return { ok: true };
});
