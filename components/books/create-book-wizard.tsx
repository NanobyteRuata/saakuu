"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AI_MODELS, DEFAULT_MODEL_ID, type AIModelId } from "@/lib/ai/models";
import { postJson } from "@/lib/api-client";
import type { EditorColumn } from "@/lib/books/column-diff";
import { pickOption } from "@/lib/books/labels";
import { labelSchema } from "@/lib/validation";

import { ColumnListEditor, validateColumns } from "./column-list-editor";

const MODEL_IDS = AI_MODELS.map((m) => m.id);

export function CreateBookWizard() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [model, setModel] = useState<AIModelId>(DEFAULT_MODEL_ID);
  const [columns, setColumns] = useState<EditorColumn[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [columnErrors, setColumnErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function next(e: FormEvent) {
    e.preventDefault();
    if (!labelSchema.safeParse(name).success) {
      setNameError("Give the book a name (up to 200 characters).");
      return;
    }
    setNameError(null);
    setStep(2);
  }

  async function create() {
    const errors = validateColumns(columns);
    setColumnErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFormError("Fix the highlighted columns first.");
      return;
    }
    setFormError(null);
    setPending(true);
    const result = await postJson<{ id: string }>("/api/books", {
      name,
      defaultModel: model,
      columns: columns.map(({ key, label, dataType, enumValues, isRequired }) => ({ key, label, dataType, enumValues, isRequired })),
    });
    if (!result.ok) {
      setPending(false);
      setFormError(result.error.message);
      return;
    }
    toast.success("Book created.");
    // Templates, not Table: the table is empty until a template reads a document (docs/06 Phase 10).
    router.push(`/books/${result.data.id}/templates`);
  }

  const modelDescription = AI_MODELS.find((m) => m.id === model)?.description;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">Step {step} of 2</p>
        <h1 className="text-2xl font-semibold tracking-tight">{step === 1 ? "Create a book" : "Output table columns"}</h1>
        <p className="text-muted-foreground text-sm">
          {step === 1
            ? "A book is one project: the spreadsheet you want to fill and everything that fills it."
            : "The columns of the spreadsheet you'll export, in order. You can leave this empty: once you've built a template, Create columns from this template proposes one column per field, and you rename what needs renaming."}
        </p>
      </div>

      {step === 1 ? (
        <form onSubmit={next} className="flex max-w-md flex-col gap-5" noValidate>
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="book-model">Default AI model</Label>
            <Select
              value={model}
              onValueChange={(value) => {
                const picked = pickOption(MODEL_IDS, value);
                if (picked) setModel(picked);
              }}
            >
              <SelectTrigger id="book-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-sm">{modelDescription} Templates can override it.</p>
          </div>
          <div className="flex gap-2">
            <Button type="submit">Next: columns</Button>
            <Button type="button" variant="ghost" onClick={() => router.push("/books")}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <ColumnListEditor columns={columns} onChange={setColumns} errors={columnErrors} disabled={pending} />
          {columns.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No columns yet. That&apos;s fine — build a template first and let the app propose them.
            </p>
          ) : null}
          {formError ? <FormMessage tone="error">{formError}</FormMessage> : null}
          <div className="flex gap-2">
            <Button type="button" onClick={create} disabled={pending}>
              {pending ? "Creating…" : columns.length === 0 ? "Create book without columns" : "Create book"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={pending}>
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
