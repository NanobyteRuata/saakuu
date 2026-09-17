export default function BookLoading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className="sr-only">Loading…</p>
      <div className="bg-muted h-10 animate-pulse rounded-lg" />
      <div className="bg-muted h-48 animate-pulse rounded-lg" />
    </div>
  );
}
