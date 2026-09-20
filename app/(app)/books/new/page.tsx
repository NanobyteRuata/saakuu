import type { Metadata } from "next";

import { CreateBookWizard } from "@/components/books/create-book-wizard";
import { PageScroll } from "@/components/shell/page-scroll";

export const metadata: Metadata = { title: "Create a book · SaaKuu" };

export default function NewBookPage() {
  return (
    <PageScroll>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <CreateBookWizard />
      </div>
    </PageScroll>
  );
}
