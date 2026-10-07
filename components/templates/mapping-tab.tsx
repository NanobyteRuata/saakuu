"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getJson, patchJson, postJson } from "@/lib/api-client";
import { COLUMN_TYPE_LABELS } from "@/lib/books/schemas";
import { plural } from "@/lib/format";
import {
  MAPPING_KIND_HINTS,
  MAPPING_KIND_LABELS,
  MULTIPLE_MARKED_HINTS,
  MULTIPLE_MARKED_LABELS,
  NONE_MARKED_HINTS,
  NONE_MARKED_LABELS,
  TICK_SELECTION_HINTS,
  TICK_SELECTION_LABELS,
} from "@/lib/mappings/labels";
import type { MappingDraft, MappingSourceInput } from "@/lib/mappings/schemas";
import type { ColumnOption, MappingsOverview, RetransformStatus } from "@/lib/mappings/service";
import type { MappingView } from "@/lib/mappings/views";
import { shortName } from "@/lib/templates/field-list";
import { FIELD_MODE_LABELS, FIELD_TYPE_LABELS } from "@/lib/templates/labels";
import { MULTIPLE_MARKED, NONE_MARKED, TICK_SELECTIONS, type MultipleMarked, type NoneMarked, type TickSelection } from "@/lib/templates/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import type { FieldView } from "@/lib/templates/views";
import { expressionFromDisplay, expressionToDisplay } from "@/lib/transform/expression";
import { DEFAULT_SEPARATOR, DEFAULT_TICK_RULES } from "@/lib/transform/mappings";
import { MAPPING_KINDS, type MappingKind } from "@/lib/transform/types";

import { TryOneDocument } from "@/components/documents/try-one-document";

import { ColumnSetupBar } from "./column-setup-bar";
import { DeleteMappingDialog } from "./delete-mapping-dialog";
import { FieldName } from "./field-name";
import { MappingPreviewPanel } from "./mapping-preview";

type SourceOption = { id: string; name: string; detail: string; isTick: boolean; tickDefault: string };

/** The template's fields in paper order. */
function sourceOptions(fields: FieldView[]): SourceOption[] {
  return fields.map((f) => ({
    id: f.id,
    name: f.labelSource,
    detail: `${FIELD_TYPE_LABELS[f.dataType]} · ${FIELD_MODE_LABELS[f.mode]}`,
    isTick: f.dataType === "MARK",
    tickDefault: shortName(f),
  }));
}

/** How expressions name fields for people: the name when no other field has it, else the id. */
function referenceNames(options: SourceOption[]): { nameFor: Map<string, string>; idFor: Map<string, string> } {
  const counts = new Map<string, number>();
  for (const o of options) counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
  const nameFor = new Map<string, string>();
  const idFor = new Map<string, string>();
  for (const o of options) {
    const safe = counts.get(o.name) === 1 && !/[{}]/u.test(o.name) ? o.name : o.id;
    nameFor.set(o.id, safe);
    idFor.set(safe, o.id);
  }
  return { nameFor, idFor };
}

type EditorState = {
  kind: MappingKind;
  inputs: MappingSourceInput[];
  separator: string;
  splitMode: "separator" | "pattern";
  splitBy: string;
  splitPart: string;
  splitRegex: string;
  constantValue: string;
  expressionText: string;
  tickSelection: TickSelection;
  noneMarked: NoneMarked;
  multipleMarked: MultipleMarked;
  noneValue: string;
  tickLabel: string;
  fillDown: boolean;
};

function initialState(mapping: MappingView | null, nameFor: Map<string, string>): EditorState {
  return {
    kind: mapping?.kind ?? "COPY",
    inputs: mapping?.inputs ?? [],
    separator: mapping?.separator ?? DEFAULT_SEPARATOR,
    splitMode: mapping?.splitRegex ? "pattern" : "separator",
    splitBy: mapping?.splitBy ?? "/",
    splitPart: String((mapping?.splitIndex ?? 0) + 1),
    splitRegex: mapping?.splitRegex ?? "",
    constantValue: mapping?.constantValue ?? "",
    expressionText: mapping?.expression ? expressionToDisplay(mapping.expression, (id) => nameFor.get(id) ?? null) : "",
    tickSelection: mapping?.ticks?.selection ?? DEFAULT_TICK_RULES.selection,
    noneMarked: mapping?.ticks?.noneMarked ?? DEFAULT_TICK_RULES.noneMarked,
    multipleMarked: mapping?.ticks?.multipleMarked ?? DEFAULT_TICK_RULES.multipleMarked,
    noneValue: mapping?.ticks?.noneValue ?? "",
    tickLabel: mapping?.ticks?.label ?? "",
    fillDown: mapping?.fillDown ?? true,
  };
}

function toDraft(columnId: string, s: EditorState, idFor: Map<string, string>): MappingDraft {
  const part = Number(s.splitPart);
  const splitting = s.kind === "SPLIT";
  return {
    outputColumnId: columnId,
    kind: s.kind,
    inputs: s.kind === "CONCAT" || s.kind === "TICKS" ? s.inputs : s.kind === "COPY" || s.kind === "SPLIT" ? s.inputs.slice(0, 1) : [],
    separator: s.kind === "CONCAT" ? s.separator : null,
    splitBy: splitting && s.splitMode === "separator" ? s.splitBy : null,
    splitIndex: splitting && s.splitMode === "separator" ? (Number.isInteger(part) && part >= 1 ? part - 1 : null) : null,
    splitRegex: splitting && s.splitMode === "pattern" ? s.splitRegex : null,
    constantValue: s.kind === "CONSTANT" ? s.constantValue : null,
    expression: s.kind === "EXPRESSION" ? expressionFromDisplay(s.expressionText, (name) => idFor.get(name) ?? null) : null,
    ticks:
      s.kind === "TICKS"
        ? { selection: s.tickSelection, noneMarked: s.noneMarked, multipleMarked: s.multipleMarked, noneValue: s.noneValue || null, label: s.tickLabel.trim() || null }
        : null,
    fillDown: s.fillDown,
  };
}

function SourcePicker({
  id,
  value,
  options,
  lang,
  onChange,
}: {
  id?: string;
  value: MappingSourceInput | undefined;
  options: SourceOption[];
  lang: string | undefined;
  onChange: (source: MappingSourceInput) => void;
}) {
  const known = options.some((o) => o.id === value?.id);
  return (
    <Select
      value={known ? value?.id : undefined}
      onValueChange={(v) => {
        if (v && v !== value?.id && options.some((o) => o.id === v)) onChange({ id: v, tickValue: null });
      }}
    >
      {/* The chosen name wraps rather than losing its end, so the trigger grows with it. */}
      <SelectTrigger id={id} className="h-auto min-h-9 w-full text-left whitespace-normal" aria-label={id ? undefined : "Field"}>
        <SelectValue placeholder={value && !known ? "A deleted field: choose another" : "Choose a field"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            <FieldName name={o.name} lang={lang} />
            <span className="text-muted-foreground ml-2 text-xs">{o.detail}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A choice from a short fixed list, with what the chosen one does written underneath. */
function RuleSelect<T extends string>({
  id,
  label,
  value,
  values,
  labels,
  hints,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  values: readonly T[];
  labels: Record<T, string>;
  hints: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => {
          const next = values.find((x) => x === v);
          if (next) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((v) => (
            <SelectItem key={v} value={v}>
              {labels[v]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">{hints[value]}</p>
    </div>
  );
}

type EditorProps = {
  column: ColumnOption;
  mapping: MappingView | null;
  template: TemplateDetail;
  options: SourceOption[];
  names: { nameFor: Map<string, string>; idFor: Map<string, string> };
  lang: string | undefined;
  onDraft: (draft: (MappingDraft & { id: string | null }) | null) => void;
  onCancel: () => void;
  onSaved: (mapping: MappingView) => void;
  onDelete: () => void;
};

function MappingEditor({ column, mapping, template, options, names, lang, onDraft, onCancel, onSaved, onDelete }: EditorProps) {
  const [state, setState] = useState(() => initialState(mapping, names.nameFor));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<EditorState>) => setState((s) => ({ ...s, ...patch }));
  const draft = useMemo(() => toDraft(column.id, state, names.idFor), [column.id, state, names.idFor]);

  useEffect(() => {
    onDraft({ ...draft, id: mapping?.id ?? null });
  }, [draft, mapping?.id, onDraft]);
  useEffect(() => () => onDraft(null), [onDraft]);

  const setInput = (i: number, source: MappingSourceInput) => set({ inputs: state.inputs.map((s, j) => (j === i ? source : s)) });
  const move = (i: number, by: number) => {
    const next = [...state.inputs];
    const [item] = next.splice(i, 1);
    if (item) next.splice(i + by, 0, item);
    set({ inputs: next });
  };
  const byId = new Map(options.map((o) => [o.id, o]));
  /** From ticks reads tick fields only, each with the value it writes; the other kinds carry no values. */
  const setKind = (kind: MappingKind) =>
    set({
      kind,
      inputs:
        kind === "TICKS"
          ? state.inputs.flatMap((i) => {
              const o = byId.get(i.id);
              return o?.isTick ? [{ id: i.id, tickValue: i.tickValue ?? o.tickDefault }] : [];
            })
          : state.inputs,
    });
  const tickOptions = options.filter((o) => o.isTick && !state.inputs.some((i) => i.id === o.id));

  async function save() {
    setPending(true);
    const result = mapping
      ? await patchJson<MappingView>(`/api/mappings/${mapping.id}`, draft)
      : await postJson<MappingView>(`/api/templates/${template.id}/mappings`, draft);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    onSaved(result.data);
  }

  const single = state.inputs[0];
  return (
    <form
      className="flex flex-col gap-4"
      aria-label={`Mapping for ${column.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="mapping-kind">How the column is filled</Label>
        <Select value={state.kind} onValueChange={(v) => setKind(MAPPING_KINDS.find((k) => k === v) ?? state.kind)}>
          <SelectTrigger id="mapping-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAPPING_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {MAPPING_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{MAPPING_KIND_HINTS[state.kind]}</p>
      </div>

      {state.kind === "COPY" || state.kind === "SPLIT" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="mapping-source">Reads</Label>
          <SourcePicker
            id="mapping-source"
            value={single}
            options={options}
            lang={lang}
            onChange={(s) => set({ inputs: [s] })}
          />
        </div>
      ) : null}

      {state.kind === "TICKS" ? (
        <>
          <div className="flex flex-col gap-2">
            <Label>Tick fields, and what each one writes</Label>
            {state.inputs.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {options.some((o) => o.isTick)
                  ? "None chosen yet. Add the tick boxes that together give this answer."
                  : "This template has no Mark / tick fields yet. Set the tick boxes' type to Mark / tick on the Fields tab first."}
              </p>
            ) : null}
            {state.inputs.map((source, i) => {
              const o = byId.get(source.id);
              return (
                <div key={source.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto] items-center gap-2">
                  {o ? <FieldName name={o.name} lang={lang} className="text-sm" /> : <span className="text-destructive text-sm">A deleted field</span>}
                  <Input
                    aria-label={`Written when ${o?.name ?? "this field"} is ticked`}
                    lang={lang}
                    className="font-value"
                    value={source.tickValue ?? ""}
                    placeholder={o?.tickDefault ?? ""}
                    onChange={(e) => setInput(i, { id: source.id, tickValue: e.target.value })}
                  />
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${o?.name ?? "this field"}`} onClick={() => set({ inputs: state.inputs.filter((_, j) => j !== i) })}>
                    <X />
                  </Button>
                </div>
              );
            })}
            {tickOptions.length > 0 ? (
              <Select
                value=""
                onValueChange={(v) => {
                  const o = tickOptions.find((x) => x.id === v);
                  if (o) set({ inputs: [...state.inputs, { id: o.id, tickValue: o.tickDefault }] });
                }}
              >
                <SelectTrigger className="w-full" aria-label="Add a tick field">
                  <SelectValue placeholder="Add a tick field…" />
                </SelectTrigger>
                <SelectContent>
                  {tickOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      <FieldName name={o.name} lang={lang} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <p className="text-muted-foreground text-xs">Only Mark / tick fields are listed. Leave a value blank to write the field&apos;s own name.</p>
          </div>

          <RuleSelect
            id="mapping-tick-selection"
            label="How many can be ticked?"
            value={state.tickSelection}
            values={TICK_SELECTIONS}
            labels={TICK_SELECTION_LABELS}
            hints={TICK_SELECTION_HINTS}
            onChange={(tickSelection) => set({ tickSelection })}
          />
          <RuleSelect
            id="mapping-none-marked"
            label="When nothing is ticked"
            value={state.noneMarked}
            values={NONE_MARKED}
            labels={NONE_MARKED_LABELS}
            hints={NONE_MARKED_HINTS}
            onChange={(noneMarked) => set({ noneMarked })}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="mapping-none-value">Write this instead of leaving it blank (optional)</Label>
            <Input id="mapping-none-value" lang={lang} className="font-value" placeholder="e.g. Not tested" value={state.noneValue} onChange={(e) => set({ noneValue: e.target.value })} />
          </div>
          {state.tickSelection === "ONE_OF" ? (
            <RuleSelect
              id="mapping-multiple-marked"
              label="When several are ticked"
              value={state.multipleMarked}
              values={MULTIPLE_MARKED}
              labels={MULTIPLE_MARKED_LABELS}
              hints={MULTIPLE_MARKED_HINTS}
              onChange={(multipleMarked) => set({ multipleMarked })}
            />
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mapping-tick-label">Name used in warnings (optional)</Label>
            <Input id="mapping-tick-label" lang={lang} className="font-value" placeholder={column.label} value={state.tickLabel} onChange={(e) => set({ tickLabel: e.target.value })} />
            <p className="text-muted-foreground text-xs">
              What a warning calls these boxes, such as the header printed above them: “Nothing is ticked in “{state.tickLabel.trim() || column.label}”.”
            </p>
          </div>
        </>
      ) : null}

      {state.kind === "CONCAT" ? (
        <div className="flex flex-col gap-2">
          <Label>Joins, in this order</Label>
          {state.inputs.map((source, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <SourcePicker value={source} options={options} lang={lang} onChange={(s) => setInput(i, s)} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move down"
                  disabled={i === state.inputs.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove"
                  onClick={() => set({ inputs: state.inputs.filter((_, j) => j !== i) })}
                >
                  <X />
                </Button>
              </div>
            </div>
          ))}
          <Select
            value=""
            onValueChange={(v) => {
              if (byId.has(v)) set({ inputs: [...state.inputs, { id: v, tickValue: null }] });
            }}
          >
            <SelectTrigger className="w-full" aria-label="Add a field to join">
              <SelectValue placeholder="Add a field…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  <FieldName name={o.name} lang={lang} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Label htmlFor="mapping-separator" className="shrink-0 font-normal">
              Separator
            </Label>
            <Input id="mapping-separator" className="w-24" value={state.separator} onChange={(e) => set({ separator: e.target.value })} />
            <span className="text-muted-foreground text-xs">Spaces count. Default is a comma and a space.</span>
          </div>
        </div>
      ) : null}

      {state.kind === "SPLIT" ? (
        <div className="flex flex-col gap-2">
          <Select value={state.splitMode} onValueChange={(v) => set({ splitMode: v === "pattern" ? "pattern" : "separator" })}>
            <SelectTrigger className="w-full" aria-label="Split method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="separator">Split on a separator and keep one part</SelectItem>
              <SelectItem value="pattern">Keep what matches a pattern</SelectItem>
            </SelectContent>
          </Select>
          {state.splitMode === "separator" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="mapping-split-by" className="font-normal">
                Split on
              </Label>
              <Input id="mapping-split-by" className="w-20" value={state.splitBy} onChange={(e) => set({ splitBy: e.target.value })} />
              <Label htmlFor="mapping-split-part" className="font-normal">
                and keep part
              </Label>
              <Input
                id="mapping-split-part"
                className="w-20"
                inputMode="numeric"
                value={state.splitPart}
                onChange={(e) => set({ splitPart: e.target.value })}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <Input
                aria-label="Pattern"
                className="font-mono"
                placeholder="e.g. /(\d+)$"
                value={state.splitRegex}
                onChange={(e) => set({ splitRegex: e.target.value })}
              />
              <p className="text-muted-foreground text-xs">A regular expression. The part in the first brackets is kept.</p>
            </div>
          )}
        </div>
      ) : null}

      {state.kind === "CONSTANT" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="mapping-constant">Value</Label>
          <Input id="mapping-constant" value={state.constantValue} onChange={(e) => set({ constantValue: e.target.value })} />
        </div>
      ) : null}

      {state.kind === "EXPRESSION" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="mapping-expression">Expression</Label>
          <Textarea
            id="mapping-expression"
            lang={lang}
            className="font-value font-mono"
            placeholder='e.g. if(number({Age}) >= 12, "adult", "child")'
            value={state.expressionText}
            onChange={(e) => set({ expressionText: e.target.value })}
          />
          <Select
            value=""
            onValueChange={(v) => {
              if (byId.has(v)) set({ expressionText: `${state.expressionText}{${names.nameFor.get(v) ?? v}}` });
            }}
          >
            <SelectTrigger className="w-full" aria-label="Insert a field">
              <SelectValue placeholder="Insert a field…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  <FieldName name={o.name} lang={lang} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {template.kind === "TABLE" && state.kind !== "CONSTANT" ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={state.fillDown} onCheckedChange={(c) => set({ fillDown: c === true })} className="mt-0.5" />
          <span>
            Fill in ditto marks from the row above
            <span className="text-muted-foreground block text-xs">Filled values are marked as copied. Off: ditto cells stay empty and are flagged.</span>
          </span>
        </label>
      ) : null}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save mapping"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {mapping ? (
          <Button type="button" variant="ghost" className="text-destructive ml-auto" onClick={onDelete} disabled={pending}>
            <Trash2 />
            Delete mapping
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function summary(mapping: MappingView, options: SourceOption[], names: { nameFor: Map<string, string> }): string {
  const option = (s: MappingView["inputs"][number]) => options.find((o) => o.id === s.id);
  const name = (s: MappingView["inputs"][number]) => option(s)?.name ?? "a deleted field";
  switch (mapping.kind) {
    case "TICKS":
      return mapping.inputs.map((s) => `${option(s)?.tickDefault ?? "a deleted field"} → ${s.tickValue ?? option(s)?.tickDefault ?? ""}`).join(", ");
    case "COPY":
      return mapping.inputs[0] ? name(mapping.inputs[0]) : "";
    case "CONCAT":
      return mapping.inputs.map(name).join(` + `);
    case "SPLIT":
      return `${mapping.inputs[0] ? name(mapping.inputs[0]) : ""}, ${
        mapping.splitRegex ? `pattern ${mapping.splitRegex}` : `part ${(mapping.splitIndex ?? 0) + 1} split on “${mapping.splitBy ?? ""}”`
      }`;
    case "CONSTANT":
      return `“${mapping.constantValue ?? ""}”`;
    case "EXPRESSION":
      return mapping.expression ? expressionToDisplay(mapping.expression, (id) => names.nameFor.get(id) ?? null) : "";
  }
}

type Props = {
  template: TemplateDetail;
  /** The template's fields in paper order. */
  fields: FieldView[];
  lang: string | undefined;
  /** Reloads the template, so the config badge follows mapping changes. */
  onChanged: () => Promise<void>;
};

/** The mapping layer (docs/01 §6.5b, docs/05 §7): how fields become output columns, with a live preview. */
export function MappingTab({ template, fields, lang, onChanged }: Props) {
  const [overview, setOverview] = useState<MappingsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [draft, setDraft] = useState<(MappingDraft & { id: string | null }) | null>(null);
  const [deleting, setDeleting] = useState<{ mappingId: string; columnLabel: string } | null>(null);
  const [status, setStatus] = useState<RetransformStatus>({ state: "idle", done: 0, total: 0, lastRun: null });
  const [trying, setTrying] = useState(false);
  /**
   * Bumped whenever the preview's own inputs change outside it — a new reading, or columns and
   * mappings created in one go — so it refetches instead of holding a stale answer.
   */
  const [previewKey, setPreviewKey] = useState(0);
  const [watching, setWatching] = useState(true);

  const options = useMemo(() => sourceOptions(fields), [fields]);
  const names = useMemo(() => referenceNames(options), [options]);

  const load = useCallback(async () => {
    const result = await getJson<MappingsOverview>(`/api/templates/${template.id}/mappings`);
    if (result.ok) {
      setOverview(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.error.message);
    }
  }, [template.id]);

  // Fields change what a mapping can read: reload when the source layer changes.
  useEffect(() => {
    void load();
  }, [load, template.fields]);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const tick = async () => {
      const result = await getJson<RetransformStatus>(`/api/templates/${template.id}/retransform`);
      if (cancelled || !result.ok) return;
      setStatus(result.data);
      if (result.data.state === "idle") setWatching(false);
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watching, template.id]);

  const onDraft = useCallback((next: (MappingDraft & { id: string | null }) | null) => setDraft(next), []);

  async function afterChange(message: string) {
    setEditingColumn(null);
    await Promise.all([load(), onChanged()]);
    setWatching(true);
    toast.success(message);
  }

  async function rebuild() {
    const result = await postJson<RetransformStatus>(`/api/templates/${template.id}/retransform`, {});
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setStatus(result.data);
    setWatching(true);
  }

  if (!overview) {
    return loadError ? (
      <div className="flex flex-col items-start gap-2">
        <FormMessage tone="error">{loadError}</FormMessage>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-muted-foreground py-10 text-center text-sm">Loading mappings…</p>
    );
  }

  const byColumn = new Map(overview.mappings.map((m) => [m.outputColumnId, m]));
  const mapped = overview.columns.filter((c) => byColumn.has(c.id));
  const unmapped = overview.columns.filter((c) => !byColumn.has(c.id));
  const used = new Set(overview.mappings.flatMap((m) => m.inputs.map((i) => i.id)));
  const unusedFields = options.filter((o) => !used.has(o.id) && !template.fields.some((f) => f.id === o.id && f.mode === "SKIP"));
  const shownColumnIds = new Set([...mapped.map((c) => c.id), ...(editingColumn ? [editingColumn] : [])]);

  const renderEditor = (column: ColumnOption) => (
    <MappingEditor
      key={column.id}
      column={column}
      mapping={byColumn.get(column.id) ?? null}
      template={template}
      options={options}
      names={names}
      lang={lang}
      onDraft={onDraft}
      onCancel={() => setEditingColumn(null)}
      onSaved={(m) => void afterChange(`Saved the mapping for “${overview.columns.find((c) => c.id === m.outputColumnId)?.label ?? column.label}”. Rows are being rebuilt.`)}
      onDelete={() => {
        const m = byColumn.get(column.id);
        if (m) setDeleting({ mappingId: m.id, columnLabel: column.label });
      }}
    />
  );

  const columnHeading = (c: ColumnOption) => (
    <div className="min-w-0">
      <p className="truncate font-medium">{c.label}</p>
      <p className="text-muted-foreground truncate text-xs">
        {c.key} · {COLUMN_TYPE_LABELS[c.dataType]}
      </p>
    </div>
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <section aria-label="Mappings" className="flex flex-col gap-4">
        <ColumnSetupBar
          bookId={template.bookId}
          templateId={template.id}
          lang={lang}
          onApplied={async (message) => {
            await Promise.all([load(), onChanged()]);
            setPreviewKey((n) => n + 1);
            setWatching(true);
            if (message) toast.success(message);
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm" aria-live="polite">
          {status.state === "idle" && status.lastRun?.error ? (
            <span className="text-destructive">{status.lastRun.error}</span>
          ) : status.state === "idle" && status.lastRun && status.lastRun.failed > 0 ? (
            <span className="text-destructive">
              The last rebuild couldn&apos;t rebuild {status.lastRun.failed} of {plural(status.lastRun.documents, "document")}. Press
              Rebuild rows to try again.
            </span>
          ) : (
            <span className="text-muted-foreground">
              {status.state === "running"
                ? `Rebuilding rows… ${status.done} of ${plural(status.total, "document")}`
                : status.state === "queued"
                  ? "Rebuilding rows shortly…"
                  : `Rows rebuild automatically after each saved change, from what the AI already read (${plural(overview.extractedDocuments, "extracted document")}). No AI cost.`}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={() => void rebuild()} disabled={status.state !== "idle" || overview.extractedDocuments === 0}>
            <RefreshCw />
            Rebuild rows
          </Button>
        </div>

        {overview.columns.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="font-medium">The book has no output columns yet</p>
            <p className="text-muted-foreground text-sm">
              These are the columns of the spreadsheet you export. Create them from this template&apos;s fields above, or
              add them by hand with Edit output columns.
            </p>
          </div>
        ) : null}

        {mapped.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Filled by this template ({mapped.length})</h3>
            <ul className="flex flex-col gap-2">
              {mapped.map((c) => {
                const m = byColumn.get(c.id);
                if (!m) return null;
                return (
                  <li key={c.id} className="rounded-lg border p-3">
                    {editingColumn === c.id ? (
                      <div className="flex flex-col gap-3">
                        {columnHeading(c)}
                        {renderEditor(c)}
                      </div>
                    ) : (
                      <div className="flex items-start gap-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          {columnHeading(c)}
                          <p className="text-sm">
                            <Badge variant="outline" className="mr-2">
                              {MAPPING_KIND_LABELS[m.kind]}
                            </Badge>
                            <span lang={lang} className="font-value break-words">
                              {summary(m, options, names)}
                            </span>
                          </p>
                          {m.problem ? (
                            <p className="text-destructive text-sm">
                              <Badge variant="destructive" className="mr-2">
                                Broken
                              </Badge>
                              {m.problem}
                            </p>
                          ) : null}
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setEditingColumn(c.id)} disabled={editingColumn !== null}>
                          <Pencil />
                          Edit
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : overview.columns.length > 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-8 text-center">
            <p className="font-medium">No columns are mapped yet</p>
            <p className="text-muted-foreground text-sm">
              Choose a column below and say which field fills it. The template stays Draft until it has a mapping.
            </p>
          </div>
        ) : null}

        {unmapped.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Not filled by this template ({unmapped.length})</h3>
            <p className="text-muted-foreground text-xs">These columns stay empty for documents read with this template.</p>
            <ul className="flex flex-col gap-2">
              {unmapped.map((c) => (
                <li key={c.id} className="rounded-lg border p-3">
                  {editingColumn === c.id ? (
                    <div className="flex flex-col gap-3">
                      {columnHeading(c)}
                      {renderEditor(c)}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">{columnHeading(c)}</div>
                      <Button size="sm" variant="outline" onClick={() => setEditingColumn(c.id)} disabled={editingColumn !== null}>
                        <Plus />
                        Map
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {unusedFields.length > 0 ? (
          <details className="rounded-lg border text-sm">
            <summary className="cursor-pointer px-3 py-2 font-medium">Fields not used by any mapping ({unusedFields.length})</summary>
            <ul className="flex flex-col gap-1 border-t px-3 py-2">
              {unusedFields.map((o) => (
                <li key={o.id}>
                  <FieldName name={o.name} lang={lang} />
                  <span className="text-muted-foreground ml-2 text-xs">{o.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-label="Preview" className="rounded-xl border p-4 lg:sticky lg:top-6">
        <MappingPreviewPanel
          key={previewKey}
          templateId={template.id}
          onTryOneDocument={() => setTrying(true)}
          columns={overview.columns}
          shownColumnIds={shownColumnIds}
          draft={draft}
          focusColumnId={editingColumn}
          lang={lang}
        />
      </section>

      <TryOneDocument
        bookId={template.bookId}
        templateId={template.id}
        templateName={template.name}
        lang={lang}
        open={trying}
        onOpenChange={setTrying}
        onExtracted={() => {
          setPreviewKey((n) => n + 1);
          void Promise.all([load(), onChanged()]);
        }}
      />

      <DeleteMappingDialog
        mappingId={deleting?.mappingId ?? null}
        columnLabel={deleting?.columnLabel ?? ""}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => afterChange(`Deleted the mapping for “${deleting?.columnLabel ?? ""}”. Rows are being rebuilt.`)}
      />
    </div>
  );
}
