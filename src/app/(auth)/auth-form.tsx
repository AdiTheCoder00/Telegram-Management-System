"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/client-api";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    // The owner account starts in the browser’s time zone (changeable in Settings).
    if (mode === "register") form.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      await api(`/api/auth/${mode}`, { method: "POST", body: form });
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else setError("Something went wrong. Please try again.");
      setPending(false);
    }
  }

  const isLogin = mode === "login";
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{isLogin ? "Sign in" : "Create the owner account"}</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {isLogin
          ? "Welcome back. Your alerts kept running while you were away."
          : "This is a personal installation: the first account becomes its owner and registration then closes."}
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        {!isLogin && <Field label="Name" name="name" autoComplete="name" error={fieldErrors.name} />}
        <Field label="Email" name="email" type="email" autoComplete="email" error={fieldErrors.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete={isLogin ? "current-password" : "new-password"}
          error={fieldErrors.password}
          hint={isLogin ? undefined : "At least 10 characters, with a letter and a number."}
        />
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {isLogin ? "Sign in" : "Create owner account"}
        </Button>
      </form>

      {!isLogin && (
        <p className="mt-6 text-sm text-muted-foreground">
          Already set up?{" "}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  error,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} autoComplete={autoComplete} required aria-invalid={!!error} className="h-10" />
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
