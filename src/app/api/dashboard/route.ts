import { route } from "@/lib/api";
import { getDashboard } from "@/lib/services/dashboard";

export const GET = route(async ({ user }) => getDashboard(user.id, user.timezone));
