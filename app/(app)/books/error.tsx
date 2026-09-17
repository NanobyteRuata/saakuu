"use client";

import { ErrorReference } from "@/components/shell/error-reference";
import { Button } from "@/components/ui/button";

export default function BooksError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-4 py-16 text-center sm:px-6">
      <p className="font-medium">We couldn&apos;t load this page.</p>
      <p className="text-muted-foreground max-w-md text-sm">
        This is usually temporary. Try again, and if it keeps happening, reload the page in a minute.
      </p>
      <Button className="mt-2" onClick={reset}>
        Try again
      </Button>
      <ErrorReference digest={error.digest} />
    </div>
  );
}
