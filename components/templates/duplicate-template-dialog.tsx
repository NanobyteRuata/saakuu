"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/api-client";
import type { TemplateKind } from "@/lib/templates/schemas";
import { labelSchema } from "@/lib/validation";

import { KindPicker } from "./kind-picker";

type Props = {
  bookId: string;
  template: { id: string; name: string; kind: TemplateKind } | null;
  /** Pre-selected type, e.g. the other kind when the user wanted to switch type. */
  initialKind?: TemplateKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Copies the source layer as a new template, optionally as the other type. The original is untouched. */
export function DuplicateTemplateDialog({ bookId, template, initialKind, open, onOpenChange }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TemplateKind>("FORM");
  const [includeMappings, setIncludeMappings] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open || !template) return;
    setName(`${template.name} (copy)`);
    setKind(initialKind ?? template.kind);
    setIncludeMappings(true);
    setError(null);
  }, [open, template, initialKind]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!template) return;
    if (!labelSchema.safeParse(name).success) {
      setError("Give the copy a name (up to 200 characters).");
      return;
    }
    setPending(true);
    const result = await postJson<{ id: string; skippedMappings: number }>(`/api/templates/${template.id}/duplicate`, {
      name: name.trim(),
      kind,
      includeMappings,
    });
    if (!result.ok) {
      setPending(false);
      setError(result.error.message);
      return;
    }
    setPending(false);
    onOpenChange(false);
    router.push(`/books/${bookId}/templates/${result.data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Duplicate “{template?.name}”</DialogTitle>
            <DialogDescription>
              Copies the groups, fields, notes, anchors and instructions into a new template. Documents are not copied,
              and the original template is not changed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="duplicate-name">New template name</Label>
            <Input id="duplicate-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <KindPicker value={kind} onChange={setKind} disabled={pending} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={includeMappings} onCheckedChange={(c) => setIncludeMappings(c === true)} disabled={pending} />
            Copy mappings to output columns too
          </label>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Duplicating…" : "Duplicate template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
