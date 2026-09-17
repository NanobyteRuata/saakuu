"use client";

import { ErrorReference } from "@/components/shell/error-reference";
import { Button } from "@/components/ui/button";

export default function AuthError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="font-medium">This page didn&apos;t load.</p>
      <p className="text-muted-foreground text-sm">
        Signing in may be briefly unavailable. Try again in a moment.
      </p>
      <Button className="mt-2" onClick={reset}>
        Try again
      </Button>
      <ErrorReference digest={error.digest} />
    </div>
  );
}
