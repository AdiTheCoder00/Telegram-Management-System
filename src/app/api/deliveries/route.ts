import { DELIVERY_STATUSES } from "@/lib/constants";
import { z } from "zod";
import { route, parseQuery } from "@/lib/api";
import { getDeliveryLogs } from "@/lib/services/history";

const schema = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = route(async ({ req, user }) => getDeliveryLogs(user.id, parseQuery(req, schema)));
