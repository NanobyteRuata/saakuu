export default function BookLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-busy="true">
      <p className="sr-only">Loading…</p>
      <div className="bg-muted h-10 shrink-0 animate-pulse rounded-lg" />
      <div className="bg-muted min-h-0 flex-1 animate-pulse rounded-lg" />
    </div>
  );
}
