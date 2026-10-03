import { route, parseQuery } from "@/lib/api";
import { historyQuerySchema } from "@/lib/validation";
import { getHistory } from "@/lib/services/history";

export const GET = route(async ({ req, user }) => getHistory(user.id, parseQuery(req, historyQuerySchema)));
