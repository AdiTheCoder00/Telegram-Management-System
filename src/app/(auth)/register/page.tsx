import { Suspense } from "react";
import Link from "next/link";
import { registrationOpen } from "@/lib/services/auth";
import { Button } from "@/components/ui/button";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (!(await registrationOpen())) {
    return (
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Registration is closed</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This is a personal installation and its owner account already exists. Sign in with that account.
        </p>
        <Button asChild size="lg" className="mt-8 w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }
  return (
    <Suspense>
      <AuthForm mode="register" />
    </Suspense>
  );
}
