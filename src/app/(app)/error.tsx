"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold">This page couldn&apos;t load</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Something went wrong while loading your data. Your alerts keep running in the background. Try again in a moment.
      </p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
