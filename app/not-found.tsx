import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        This address doesn&apos;t match anything in SaaKuu. Check the link, or go back to your books.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/books">Go to your books</Link>
      </Button>
    </main>
  );
}
