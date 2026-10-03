import { Suspense } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // First run: no owner yet → go straight to account setup.
  if ((await db.user.count()) === 0) redirect("/register");
  return (
    <Suspense>
      <AuthForm mode="login" />
    </Suspense>
  );
}
