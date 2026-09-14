"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/api-client";
import type { TemplateKind } from "@/lib/templates/schemas";
import { labelSchema } from "@/lib/validation";

import { KindPicker } from "./kind-picker";

export function CreateTemplateDialog({ bookId, label = "New template" }: { bookId: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TemplateKind>("FORM");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!labelSchema.safeParse(name).success) {
      setError("Give the template a name (up to 200 characters).");
      return;
    }
    setPending(true);
    const result = await postJson<{ id: string }>(`/api/books/${bookId}/templates`, { name: name.trim(), kind });
    if (!result.ok) {
      setPending(false);
      setError(result.error.message);
      return;
    }
    router.push(`/books/${bookId}/templates/${result.data.id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setName("");
          setKind("FORM");
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New template</DialogTitle>
            <DialogDescription>
              A template describes one kind of paper document. The type can&apos;t be changed later, but you can
              duplicate a template as the other type.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="template-name">Template name</Label>
            <Input id="template-name" placeholder="Vaccination card 2023" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <KindPicker value={kind} onChange={setKind} disabled={pending} />
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
