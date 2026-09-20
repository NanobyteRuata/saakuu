import { PageScroll } from "@/components/shell/page-scroll";

export default function BooksLoading() {
  return (
    <PageScroll>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6" aria-busy="true">
        <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
        <p className="sr-only">Loading your books…</p>
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-muted h-16 animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    </PageScroll>
  );
}
