import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { AppShell } from "@/components/app-shell";
import { LOCAL_SESSION_ID } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AppShell user={{ name: user.name, email: user.email, localMode: user.sessionId === LOCAL_SESSION_ID }}>{children}</AppShell>;
}
