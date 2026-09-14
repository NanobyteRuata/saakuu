import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Lives at the /books segment (not inside [bookId]) because `notFound()` thrown from the
 * [bookId] layout is caught by the parent segment's boundary.
 */
export default function BookNotFound() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-4 py-16 text-center sm:px-6">
      <h1 className="text-xl font-semibold">Book not found</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        This book doesn&apos;t exist, was deleted, or belongs to another account.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/books">Back to your books</Link>
      </Button>
    </div>
  );
}
