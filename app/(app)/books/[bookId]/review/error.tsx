"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { ErrorReference } from "@/components/shell/error-reference";
import { Button } from "@/components/ui/button";

export default function ReviewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { bookId } = useParams<{ bookId: string }>();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="font-medium">We couldn&apos;t load row review.</p>
      <p className="text-muted-foreground text-sm">Your data is safe, and every change you made was saved as you went. Try again, or go back to the table.</p>
      <div className="mt-2 flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" asChild>
          <Link href={`/books/${bookId}`}>Back to the table</Link>
        </Button>
      </div>
      <ErrorReference digest={error.digest} />
    </div>
  );
}
