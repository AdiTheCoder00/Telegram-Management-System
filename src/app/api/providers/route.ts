import { route } from "@/lib/api";
import { defaultProviderKey, listProviders } from "@/lib/market-data/registry";

export const GET = route(async () => ({ providers: listProviders(), defaultProvider: defaultProviderKey() }));
