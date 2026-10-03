import { route } from "@/lib/api";

export const GET = route(async ({ user }) => ({
  user: { id: user.id, email: user.email, name: user.name, timezone: user.timezone },
}));
