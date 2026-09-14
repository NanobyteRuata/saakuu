"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { patchJson } from "@/lib/api-client";
import { exportTokenSchema } from "@/lib/books/schemas";

type Props = { bookId: string; blankToken: string; illegibleToken: string };

export function ExportPrefsForm({ bookId, blankToken, illegibleToken }: Props) {
  const router = useRouter();
  const [blank, setBlank] = useState(blankToken);
  const [illegible, setIllegible] = useState(illegibleToken);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = blank !== blankToken || illegible !== illegibleToken;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!exportTokenSchema.safeParse(blank).success || !exportTokenSchema.safeParse(illegible).success) {
      setError("Keep tokens to 20 characters or fewer.");
      return;
    }
    setPending(true);
    const result = await patchJson(`/api/books/${bookId}`, { exportPrefs: { blankToken: blank, illegibleToken: illegible } });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    toast.success("Export preferences saved.");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="export-blank">Blank cells export as</Label>
        <Input id="export-blank" className="font-mono" placeholder="(empty)" value={blank} onChange={(e) => setBlank(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="export-illegible">Illegible cells export as</Label>
        <Input id="export-illegible" className="font-mono" value={illegible} onChange={(e) => setIllegible(e.target.value)} />
      </div>
      {error ? (
        <div className="sm:col-span-2">
          <FormMessage tone="error">{error}</FormMessage>
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save export preferences"}
        </Button>
      </div>
    </form>
  );
}
