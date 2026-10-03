import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { symbolSchema } from "@/lib/validation";
import { ingestTicks } from "@/lib/services/prices";
import { isValidProvider } from "@/lib/market-data/registry";
import { deliverAfterResponse } from "@/lib/notifications/dispatch";
import { badRequest } from "@/lib/errors";

const schema = z.object({
  symbol: symbolSchema,
  price: z.coerce.number().positive().finite(),
  provider: z.string().max(40),
});

/**
 * Price simulator: injects a price tick for the signed-in user's own alerts on a provider/symbol
 * (scope = userId, so other users are never affected). Used to test alerts end-to-end.
 */
export const POST = route(
  async ({ req, user }) => {
    const input = await parseBody(req, schema);
    if (!isValidProvider(input.provider)) throw badRequest("Unknown data provider.");
    const out = await ingestTicks(input.provider, user.id, [{ symbol: input.symbol, price: input.price, time: new Date() }]);
    // Without a queue, deliver after the response is sent (the worker's outbox sweep is the safety net).
    if (!out.queued) deliverAfterResponse(out.deliveryIds);
    return { ...out.results[0], deliveries: out.deliveryIds.length };
  },
  { rateLimit: [60, 60_000], bucket: "simulate" },
);
