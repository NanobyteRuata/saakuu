"use client";

import { ErrorReference } from "@/components/shell/error-reference";
import { Button } from "@/components/ui/button";

export default function BookError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border px-6 py-16 text-center">
      <p className="font-medium">We couldn&apos;t load this part of the book.</p>
      <p className="text-muted-foreground max-w-md text-sm">
        Your data is safe. This is usually temporary; try again, and reload the page if it keeps happening.
      </p>
      <Button className="mt-2" onClick={reset}>
        Try again
      </Button>
      <ErrorReference digest={error.digest} />
    </div>
  );
}
