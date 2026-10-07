"use client";

import { Plus, Trash2 } from "lucide-react";
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
import type { DateEra } from "@/lib/books/schemas";
import {
  FIELD_GUIDANCE,
  FIELD_MODE_HINTS,
  FIELD_MODE_LABELS,
  FIELD_TYPE_LABELS,
  TWO_DIGIT_YEAR_LABELS,
  twoDigitYearHint,
} from "@/lib/templates/labels";
import {
  FIELD_MODES,
  FIELD_TYPES,
  fieldShapeProblem,
  TWO_DIGIT_YEAR_RULES,
  type FieldMode,
  type FieldType,
  type MarkSymbols,
  type TwoDigitYearRule,
} from "@/lib/templates/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import type { FieldView } from "@/lib/templates/views";

import { useAutosaveForm, type Flush } from "./autosave";
import { ChipListEditor } from "./chip-list-editor";
import { duplicateNameWarning } from "./field-list";

const MARK_MEANINGS = [
  { value: "true", label: "Yes / ticked" },
  { value: "false", label: "No / not given" },
  { value: "count", label: "Count the strokes" },
] as const;

type MarkMeaning = (typeof MARK_MEANINGS)[number]["value"];

export type FieldDraft = {
  labelSource: string;
  labelMeaning: string;
  dataType: FieldType;
  mode: FieldMode;
  note: string;
  choices: string[];
  marks: { symbol: string; meaning: MarkMeaning }[];
  twoDigitYear: TwoDigitYearRule;
  pivotYear: string;
};

function toDraft(f: FieldView): FieldDraft {
  return {
    labelSource: f.labelSource,
    labelMeaning: f.labelMeaning ?? "",
    dataType: f.dataType,
    mode: f.mode,
    note: f.note ?? "",
    choices: f.choices,
    marks: Object.entries(f.markSymbols ?? {}).map(([symbol, v]) => ({
      symbol,
      meaning: v === "count" ? "count" : v ? "true" : "false",
    })),
    twoDigitYear: f.typeOptions?.date?.twoDigitYear ?? "REFUSE",
    pivotYear:
      f.typeOptions?.date?.pivotYear === undefined ||
      f.typeOptions.date.pivotYear === null
        ? ""
        : String(f.typeOptions.date.pivotYear),
  };
}

function pivotNumber(value: string): number | null {
  const n = Number(value.trim());
  return value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 99
    ? n
    : null;
}

function toPayload(d: FieldDraft) {
  const markSymbols: MarkSymbols | null =
    d.dataType === "MARK" && d.marks.length > 0
      ? Object.fromEntries(
          d.marks.map((m) => [
            m.symbol.trim(),
            m.meaning === "count" ? "count" : m.meaning === "true",
          ]),
        )
      : null;
  return {
    labelSource: d.labelSource.trim(),
    labelMeaning: d.labelMeaning.trim() || null,
    dataType: d.dataType,
    mode: d.mode,
    note: d.note.trim() || null,
    choices: d.dataType === "CHOICE" ? d.choices : [],
    markSymbols,
    typeOptions:
      d.dataType === "DATE"
        ? {
            date: {
              twoDigitYear: d.twoDigitYear,
              pivotYear:
                d.twoDigitYear === "PIVOT" ? pivotNumber(d.pivotYear) : null,
            },
          }
        : null,
  };
}

function draftProblem(d: FieldDraft): string | null {
  if (!d.labelSource.trim())
    return "Enter the name as it's written on the paper.";
  if (d.dataType === "MARK") {
    const symbols = d.marks.map((m) => m.symbol.trim());
    if (symbols.some((s) => s === ""))
      return "Fill in every mark symbol, or remove the empty row.";
    if (new Set(symbols).size !== symbols.length)
      return "Each mark symbol can only be listed once.";
  }
  return fieldShapeProblem(toPayload(d));
}

type Props = {
  field: FieldView;
  template: TemplateDetail;
  /** Another live field of the template has this field's name. A warning only: saving is never refused. */
  duplicateName: boolean;
  lang: string | undefined;
  /** The book's date era: two-digit years are read in that era's century. */
  bookDateEra: DateEra;
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
  bookDateEra,
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

      {draft.dataType === "DATE" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="field-two-digit-year">
            Dates written with a two-digit year
          </Label>
          <Select
            value={draft.twoDigitYear}
            onValueChange={(v) => {
              const twoDigitYear =
                pickOption(TWO_DIGIT_YEAR_RULES, v) ?? draft.twoDigitYear;
              set({
                twoDigitYear,
                pivotYear:
                  twoDigitYear === "PIVOT" && draft.pivotYear.trim() === ""
                    ? "50"
                    : draft.pivotYear,
              });
            }}
          >
            <SelectTrigger id="field-two-digit-year" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TWO_DIGIT_YEAR_RULES.map((rule) => (
                <SelectItem key={rule} value={rule}>
                  {TWO_DIGIT_YEAR_LABELS[rule]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draft.twoDigitYear === "PIVOT" ? (
            <div className="flex items-center gap-2">
              <Label htmlFor="field-pivot-year" className="font-normal">
                Split at
              </Label>
              <Input
                id="field-pivot-year"
                className="w-20"
                inputMode="numeric"
                placeholder="50"
                value={draft.pivotYear}
                onChange={(e) => set({ pivotYear: e.target.value })}
              />
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {twoDigitYearHint(
              draft.twoDigitYear,
              bookDateEra,
              pivotNumber(draft.pivotYear),
            )}{" "}
            The AI always copies the date as written; this decides how it is
            read afterwards.
          </p>
        </div>
      ) : null}

      {draft.dataType === "MARK" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            What the marks mean
          </legend>
          {draft.marks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No symbols yet. Add the ticks, crosses or tallies used on this
              form.
            </p>
          ) : null}
          {draft.marks.map((mark, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={`Mark ${i + 1} symbol`}
                className="font-value w-24"
                placeholder="✓"
                value={mark.symbol}
                onChange={(e) =>
                  set({
                    marks: draft.marks.map((m, j) =>
                      j === i ? { ...m, symbol: e.target.value } : m,
                    ),
                  })
                }
              />
              <Select
                value={mark.meaning}
                onValueChange={(v) => {
                  const meaning = MARK_MEANINGS.find(
                    (o) => o.value === v,
                  )?.value;
                  if (meaning)
                    set({
                      marks: draft.marks.map((m, j) =>
                        j === i ? { ...m, meaning } : m,
                      ),
                    });
                }}
              >
                <SelectTrigger
                  aria-label={`Mark ${i + 1} meaning`}
                  className="flex-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MARK_MEANINGS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove mark ${i + 1}`}
                onClick={() =>
                  set({ marks: draft.marks.filter((_, j) => j !== i) })
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                set({
                  marks: [...draft.marks, { symbol: "", meaning: "true" }],
                })
              }
            >
              <Plus />
              Add a symbol
            </Button>
            {draft.marks.length === 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  set({
                    marks: [
                      { symbol: "✓", meaning: "true" },
                      { symbol: "✗", meaning: "false" },
                    ],
                  })
                }
              >
                Add ✓ and ✗
              </Button>
            ) : null}
          </div>
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
