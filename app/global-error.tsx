"use client";

import "./globals.css";

import { ErrorReference } from "@/components/shell/error-reference";
import { Button } from "@/components/ui/button";

/** Last-resort boundary: replaces the root layout when it fails, so it renders its own document. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center">
          <h1 className="text-xl font-semibold">SaaKuu couldn&apos;t load</h1>
          <p className="text-muted-foreground max-w-md text-sm">
            Your data is safe. Something went wrong on our side; try again, and if it keeps happening, reload in a few minutes.
          </p>
          <Button className="mt-2" onClick={reset}>
            Try again
          </Button>
          <ErrorReference digest={error.digest} />
        </main>
      </body>
    </html>
  );
}
