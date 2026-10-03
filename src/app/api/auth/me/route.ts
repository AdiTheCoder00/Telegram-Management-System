import { route } from "@/lib/api";

export const GET = route(async ({ user }) => ({ user }));
