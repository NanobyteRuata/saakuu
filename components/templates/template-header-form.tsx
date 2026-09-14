"use client";

import { Copy } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AI_MODELS, modelLabel } from "@/lib/ai/models";
import { patchJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import { langOf, LANGUAGE_HINTS, TEMPLATE_KIND_LABELS } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { labelSchema } from "@/lib/validation";

import { ConfigBadge, KindBadge } from "./badges";
import { ChipListEditor } from "./chip-list-editor";

const NO_LANGUAGE = "none";
const BOOK_MODEL = "book";

function configHint(t: TemplateDetail): string {
  switch (t.configState) {
    case "CONFLICTED":
      return `${plural(t.brokenMappingCount, "mapping")} ${t.brokenMappingCount === 1 ? "is" : "are"} broken. Fix ${t.brokenMappingCount === 1 ? "it" : "them"} in the Mapping tab; the other mappings keep working.`;
    case "READY":
      return t.unmappedFieldCount > 0
        ? `Ready. ${plural(t.unmappedFieldCount, "field")} ${t.unmappedFieldCount === 1 ? "isn't" : "aren't"} mapped to a column yet.`
        : "Ready to extract.";
    case "DRAFT":
      return t.fields.length === 0
        ? "Draft: add the fields to read from the paper, then map them to output columns."
        : "Draft: map at least one field to an output column to make this template ready.";
  }
}

type Props = {
  template: TemplateDetail;
  bookDefaultModel: string;
  onSaved: (template: TemplateDetail) => void;
  onDuplicate: () => void;
};

export function TemplateHeaderForm({ template, bookDefaultModel, onSaved, onDuplicate }: Props) {
  const [name, setName] = useState(template.name);
  const [languageHint, setLanguageHint] = useState(template.languageHint ?? NO_LANGUAGE);
  const [model, setModel] = useState(template.modelOverride ?? BOOK_MODEL);
  const [anchors, setAnchors] = useState(template.anchors);
  const [instructions, setInstructions] = useState(template.instructions ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const payload = {
    name: name.trim(),
    languageHint: languageHint === NO_LANGUAGE ? null : languageHint,
    modelOverride: model === BOOK_MODEL ? null : model,
    anchors,
    instructions: instructions.trim() || null,
  };
  const dirty =
    payload.name !== template.name ||
    payload.languageHint !== template.languageHint ||
    payload.modelOverride !== template.modelOverride ||
    anchors.join("\n") !== template.anchors.join("\n") ||
    payload.instructions !== template.instructions;

  const otherKind = template.kind === "FORM" ? "TABLE" : "FORM";
  const sequenceField = template.fields.find((f) => f.id === template.sequenceFieldId);
  const languageOptions: { value: string; label: string }[] = [...LANGUAGE_HINTS];
  if (template.languageHint && !languageOptions.some((o) => o.value === template.languageHint)) {
    languageOptions.push({ value: template.languageHint, label: template.languageHint });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!labelSchema.safeParse(name).success) {
      setError("A template needs a name (up to 200 characters).");
      return;
    }
    setPending(true);
    const result = await patchJson<TemplateDetail>(`/api/templates/${template.id}`, payload);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    onSaved(result.data);
    toast.success("Template settings saved.");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border p-5" noValidate aria-label="Template settings">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <Label htmlFor="template-name">Template name</Label>
          <Input id="template-name" className="text-base font-medium" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            <KindBadge kind={template.kind} />
            <ConfigBadge state={template.configState} />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onDuplicate}>
            <Copy />
            Duplicate as {TEMPLATE_KIND_LABELS[otherKind]}
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground -mt-2 text-sm">
        {configHint(template)} The type ({TEMPLATE_KIND_LABELS[template.kind]}) can&apos;t change after creation.
        {template.kind === "TABLE"
          ? sequenceField
            ? ` Sequence field: ${sequenceField.labelSource}.`
            : " No sequence field yet: mark the numbered column in its field properties."
          : ""}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="template-language">Language on the paper</Label>
          <Select value={languageHint} onValueChange={(v) => v && setLanguageHint(v)}>
            <SelectTrigger id="template-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_LANGUAGE}>Not specified</SelectItem>
              {languageOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="template-model">AI model</Label>
          <Select value={model} onValueChange={(v) => v && setModel(v)}>
            <SelectTrigger id="template-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BOOK_MODEL}>Book default ({modelLabel(bookDefaultModel)})</SelectItem>
              {AI_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="template-anchors">Anchors</Label>
        <ChipListEditor
          id="template-anchors"
          label="Add an anchor"
          placeholder="Printed text on the page, then press Enter"
          values={anchors}
          onChange={setAnchors}
          lang={langOf(payload.languageHint)}
          disabled={pending}
        />
        <p className="text-muted-foreground text-xs">
          Printed words you expect on every page, such as the form title. A photo that doesn&apos;t show them is flagged
          as a possible wrong template before anyone reviews it.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="template-instructions">Instructions for the AI</Label>
        <Textarea
          id="template-instructions"
          placeholder="e.g. The card has two sides; the dose table is on the back."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>

      <label className="text-muted-foreground flex items-center gap-2 text-sm" title="Coming soon">
        <Checkbox checked={false} disabled aria-describedby="double-extraction-hint" />
        Double extraction
        <span id="double-extraction-hint" className="text-xs">
          (coming soon: read each document twice and flag disagreements)
        </span>
      </label>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <div>
        <Button type="submit" disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save template settings"}
        </Button>
      </div>
    </form>
  );
}
