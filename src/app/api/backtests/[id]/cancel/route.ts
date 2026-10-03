import { route } from "@/lib/api";
import { cancelBacktest } from "@/lib/services/backtests";

export const POST = route<{ id: string }>(async ({ user, params }) => ({ backtest: await cancelBacktest(user.id, params.id) }));
