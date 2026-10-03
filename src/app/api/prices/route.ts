import { z } from "zod";
import { route, parseQuery } from "@/lib/api";
import { symbolSchema } from "@/lib/validation";
import { getDisplayPrice } from "@/lib/services/prices";
import { defaultProviderKey } from "@/lib/market-data/registry";

const schema = z.object({ symbol: symbolSchema, provider: z.string().max(40).optional() });

export const GET = route(
  async ({ req, user }) => {
    const q = parseQuery(req, schema);
    const provider = q.provider ?? defaultProviderKey();
    return { symbol: q.symbol, provider, ...(await getDisplayPrice(provider, q.symbol, user.id)) };
  },
  { rateLimit: [120, 60_000], bucket: "prices" },
);
