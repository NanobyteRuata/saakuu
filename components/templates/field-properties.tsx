"use client";

import { Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { patchJson } from "@/lib/api-client";
import { pickOption } from "@/lib/books/labels";
import {
  FIELD_GUIDANCE,
  FIELD_MODE_HINTS,
  FIELD_MODE_LABELS,
  FIELD_TYPE_LABELS,
} from "@/lib/templates/labels";
import {
  FIELD_MODES,
  FIELD_TYPES,
  fieldShapeProblem,
  MAX_MARK_SYMBOLS,
  type FieldMode,
  type FieldType,
} from "@/lib/templates/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import type { FieldView } from "@/lib/templates/views";

import { useAutosaveForm, type Flush } from "./autosave";
import { ChipListEditor } from "./chip-list-editor";
import { duplicateNameWarning } from "./field-list";

export type FieldDraft = {
  labelSource: string;
  labelMeaning: string;
  dataType: FieldType;
  mode: FieldMode;
  note: string;
  choices: string[];
  /** Mark fields: the symbols used on the paper. What each means is the mapping's Read as (decision 86). */
  marks: string[];
};

function toDraft(f: FieldView): FieldDraft {
  return {
    labelSource: f.labelSource,
    labelMeaning: f.labelMeaning ?? "",
    dataType: f.dataType,
    mode: f.mode,
    note: f.note ?? "",
    choices: f.choices,
    marks: f.markSymbols,
  };
}

function toPayload(d: FieldDraft) {
  return {
    labelSource: d.labelSource.trim(),
    labelMeaning: d.labelMeaning.trim() || null,
    dataType: d.dataType,
    mode: d.mode,
    note: d.note.trim() || null,
    choices: d.dataType === "CHOICE" ? d.choices : [],
    markSymbols: d.dataType === "MARK" ? d.marks : [],
  };
}

function draftProblem(d: FieldDraft): string | null {
  if (!d.labelSource.trim())
    return "Enter the name as it's written on the paper.";
  return fieldShapeProblem(toPayload(d));
}

type Props = {
  field: FieldView;
  template: TemplateDetail;
  /** Another live field of the template has this field's name. A warning only: saving is never refused. */
  duplicateName: boolean;
  lang: string | undefined;
  onSaved: (field: FieldView) => void;
  onTemplate: (template: TemplateDetail) => void;
  onDelete: () => void;
  /**
   * Drafts the parent holds on to. A draft that will not save — an empty label, a half-filled mark
   * row — must not disappear because the operator clicked another field, so it waits here and is
   * restored with its message when they come back. No modal, and no typing lost (decision 72).
   */
  drafts: Map<string, FieldDraft>;
  registerFlush?: (flush: Flush | null) => void;
};

export function FieldProperties({
  field,
  template,
  duplicateName,
  lang,
  onSaved,
  onTemplate,
  onDelete,
  drafts,
  registerFlush,
}: Props) {
  const [draft, setDraft] = useState(
    () => drafts.get(field.id) ?? toDraft(field),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sequencePending, setSequencePending] = useState(false);

  // The flush the parent calls must be stable, and must still see what is in the form right now.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saved = JSON.stringify(toPayload(toDraft(field)));
  const dirty = JSON.stringify(toPayload(draft)) !== saved;
  const isSequence = template.sequenceFieldId === field.id;
  const set = (patch: Partial<FieldDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));

  // An unsaved draft is kept by the parent, so leaving this field and coming back loses nothing.
  useEffect(() => {
    if (dirty) drafts.set(field.id, draft);
    else drafts.delete(field.id);
  }, [dirty, draft, drafts, field.id]);

  const save = useCallback(async () => {
    const current = draftRef.current;
    const problem = draftProblem(current);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    const result = await patchJson<FieldView>(
      `/api/fields/${field.id}`,
      toPayload(current),
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setDraft(toDraft(result.data));
    onSaved(result.data);
  }, [field.id, onSaved]);

  const { onBlur } = useAutosaveForm({ dirty, save, registerFlush });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void save();
  }

  async function setSequence(on: boolean) {
    setSequencePending(true);
    const result = await patchJson<TemplateDetail>(
      `/api/templates/${template.id}`,
      { sequenceFieldId: on ? field.id : null },
    );
    setSequencePending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    onTemplate(result.data);
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4"
      noValidate
      aria-label="Field properties form"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="field-label-source">Name on the paper</Label>
        <Textarea
          id="field-label-source"
          lang={lang}
          rows={1}
          className="font-value min-h-9 resize-none text-base [field-sizing:content]"
          value={draft.labelSource}
          onChange={(e) => set({ labelSource: e.target.value.replace(/\n/g, " ") })}
        />
        <p className="text-muted-foreground text-xs">
          As written. If a header is printed above it, put the header in
          front, joined with ›, like{" "}
          <span lang={lang} className="font-value">
            Day 1 › Temp
          </span>
          . That tells two columns with the same label apart, for the AI and
          for you.
        </p>
        {duplicateName ? (
          <FormMessage tone="info">
            {duplicateNameWarning(field.labelSource)}
          </FormMessage>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="field-label-meaning">Meaning in English</Label>
        <Input
          id="field-label-meaning"
          placeholder="e.g. Day 1 › Temperature"
          value={draft.labelMeaning}
          onChange={(e) => set({ labelMeaning: e.target.value })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="field-type">Type</Label>
          <Select
            value={draft.dataType}
            onValueChange={(v) =>
              set({ dataType: pickOption(FIELD_TYPES, v) ?? draft.dataType })
            }
          >
            <SelectTrigger id="field-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draft.mode === "MANUAL" ? (
            <p className="text-muted-foreground text-xs">
              Not sent to the AI. It decides how a new mapping reads what you
              type.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="field-mode">Mode</Label>
          <Select
            value={draft.mode}
            onValueChange={(v) =>
              set({ mode: pickOption(FIELD_MODES, v) ?? draft.mode })
            }
          >
            <SelectTrigger id="field-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {FIELD_MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        {FIELD_MODE_HINTS[draft.mode]}
        {isSequence
          ? " This is the sequence field, so it has to stay on Extract."
          : ""}
        <span className="mt-1 block">{FIELD_GUIDANCE[template.kind]}</span>
      </p>

      {draft.dataType === "CHOICE" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="field-choices">Choices</Label>
          <ChipListEditor
            id="field-choices"
            label="Add a choice"
            placeholder="A possible value, then press Enter"
            values={draft.choices}
            onChange={(choices) => set({ choices })}
            lang={lang}
          />
        </div>
      ) : null}

      {draft.dataType === "MARK" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            Marks used on this paper
          </legend>
          <ChipListEditor
            label="Add a mark"
            placeholder="A mark such as ✓, then press Enter"
            values={draft.marks}
            onChange={(marks) => set({ marks: marks.slice(0, MAX_MARK_SYMBOLS) })}
            lang={lang}
          />
          {draft.marks.length === 0 ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => set({ marks: ["✓", "✗"] })}
              >
                Add ✓ and ✗
              </Button>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            The AI is told these are the marks to expect. What each one means
            is set on the Mapping tab, under Read as, and costs no reading to
            change.
          </p>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="field-note">Note for the AI</Label>
        <Textarea
          id="field-note"
          placeholder="e.g. People write 1 1/2 to mean 1 year and 6 months."
          value={draft.note}
          onChange={(e) => set({ note: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          An instruction sent with this field. The AI still copies what is
          written; conversion happens afterwards.
        </p>
      </div>

      {template.kind === "TABLE" ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={isSequence}
            disabled={sequencePending || field.mode !== "EXTRACT"}
            onCheckedChange={(c) => void setSequence(c === true)}
          />
          <span className="flex flex-col">
            <span className="font-medium">Use as the sequence field</span>
            <span className="text-muted-foreground">
              {field.mode !== "EXTRACT"
                ? "Only fields the AI reads can be the sequence field."
                : "The running row number. It catches skipped rows and rows repeated across overlapping photos."}
            </span>
          </span>
        </label>
      ) : null}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {pending
            ? "Saving…"
            : dirty
              ? "Saves when you move on"
              : "All changes saved"}
        </p>
        <Button
          type="button"
          variant="ghost"
          className="text-destructive ml-auto"
          onClick={onDelete}
          disabled={pending}
        >
          <Trash2 />
          Delete field
        </Button>
      </div>
    </form>
  );
}
