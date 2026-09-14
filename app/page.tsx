import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">SaaKuu</h1>
      <p className="text-muted-foreground">
        Photograph handwritten forms, let the AI take a first pass, then review every cell
        against the source photo and export CSV.
      </p>
      <div>
        <Button asChild variant="outline">
          <a href="/api/health">System status</a>
        </Button>
      </div>
    </main>
  );
}
