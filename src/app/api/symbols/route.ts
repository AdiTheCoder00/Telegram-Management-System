import { route } from "@/lib/api";
import { db } from "@/lib/db";

export const GET = route(async () => ({
  instruments: await db.instrument.findMany({
    orderBy: { symbol: "asc" },
    select: { symbol: true, displayName: true, assetClass: true, exchange: true, provider: true, decimals: true },
  }),
}));
