"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/api-client";
import { labelSchema } from "@/lib/validation";

/**
 * Create Book (docs/05 §3). One step since Phase 14. Step 2 asked an operator to author a schema for
 * data they had not read yet — the first wall in the product — and Phase 10 had already softened it to
 * optional, leaving a primary button named after an absence (`Create book without columns`). Columns
 * come from the template instead, where `Create columns from this template` proposes them.
 */
export function CreateBookWizard() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!labelSchema.safeParse(name).success) {
      setNameError("Give the book a name (up to 200 characters).");
      return;
    }
    setNameError(null);
    setFormError(null);
    setPending(true);
    const result = await postJson<{ id: string }>("/api/books", { name });
    if (!result.ok) {
      setPending(false);
      setFormError(result.error.message);
      return;
    }
    toast.success("Book created.");
    // Templates, not Table: the table is empty until a template reads a document (docs/06 Phase 10).
    router.push(`/books/${result.data.id}/templates`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create a book</h1>
        <p className="text-muted-foreground text-sm">
          A book is one project: the spreadsheet you want to fill and everything that fills it. Its columns come later,
          from the first template you build.
        </p>
      </div>

      <form onSubmit={create} className="flex max-w-md flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="book-name">Book name</Label>
          <Input
            id="book-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Vaccination cards 2023"
            autoFocus
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "book-name-error" : undefined}
          />
          {nameError ? (
            <p id="book-name-error" role="alert" className="text-destructive text-sm">
              {nameError}
            </p>
          ) : null}
        </div>
        {formError ? <FormMessage tone="error">{formError}</FormMessage> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create book"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push("/books")} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
