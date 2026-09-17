import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function TemplateNotFound() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border px-6 py-16 text-center">
      <p className="font-medium">Template not found</p>
      <p className="text-muted-foreground max-w-md text-sm">
        This template doesn&apos;t exist, was deleted, or belongs to a different book.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/books">Back to your books</Link>
      </Button>
    </div>
  );
}
