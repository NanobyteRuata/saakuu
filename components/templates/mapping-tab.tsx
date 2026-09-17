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
import { MAPPING_KIND_HINTS, MAPPING_KIND_LABELS } from "@/lib/mappings/labels";
import type { MappingDraft, MappingSourceInput } from "@/lib/mappings/schemas";
import type { ColumnOption, MappingsOverview, RetransformStatus } from "@/lib/mappings/service";
import type { MappingView } from "@/lib/mappings/views";
import { FIELD_MODE_LABELS, FIELD_TYPE_LABELS, GROUP_SELECTION_LABELS } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { flattenTree, formatPath, headerPath, selectionOptions, type Tree } from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";
import { expressionFromDisplay, expressionToDisplay } from "@/lib/transform/expression";
import { DEFAULT_SEPARATOR, optionLabel } from "@/lib/transform/mappings";
import { MAPPING_KINDS, type MappingKind } from "@/lib/transform/types";

import { DeleteMappingDialog } from "./delete-mapping-dialog";
import { MappingPreviewPanel } from "./mapping-preview";

type SourceTree = Tree<GroupView, FieldView>;

type SourceOption = { value: string; kind: "field" | "group"; id: string; label: string; path: string; detail: string };

/** Fields in paper order, and tick groups (One of / Any of) that resolve to an answer. */
function sourceOptions(tree: SourceTree): SourceOption[] {
  return flattenTree(tree).flatMap((node): SourceOption[] => {
    if (node.kind === "field") {
      return [
        {
          value: `field:${node.id}`,
          kind: "field",
          id: node.id,
          label: node.field.labelSource,
          path: formatPath(headerPath(tree, { kind: "field", id: node.id })),
          detail: `${FIELD_TYPE_LABELS[node.field.dataType]} · ${FIELD_MODE_LABELS[node.field.mode]}`,
        },
      ];
    }
    if (node.group.selection === "NONE") return [];
    return [
      {
        value: `group:${node.id}`,
        kind: "group",
        id: node.id,
        label: node.group.labelSource,
        path: formatPath(headerPath(tree, { kind: "group", id: node.id })),
        detail: `Tick group · ${GROUP_SELECTION_LABELS[node.group.selection]}`,
      },
    ];
  });
}

/** How expressions name fields for people: the label when unique, else the header path, else the id. */
function referenceNames(options: SourceOption[]): { nameFor: Map<string, string>; idFor: Map<string, string> } {
  const count = (key: (o: SourceOption) => string) => {
    const counts = new Map<string, number>();
    for (const o of options) counts.set(key(o), (counts.get(key(o)) ?? 0) + 1);
    return counts;
  };
  const labels = count((o) => o.label);
  const paths = count((o) => o.path);
  const nameFor = new Map<string, string>();
  const idFor = new Map<string, string>();
  for (const o of options) {
    const name = labels.get(o.label) === 1 ? o.label : paths.get(o.path) === 1 ? o.path : o.id;
    const safe = /[{}]/u.test(name) ? o.id : name;
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
  fillDown: boolean;
};

function initialState(mapping: MappingView | null, nameFor: Map<string, string>): EditorState {
  return {
    kind: mapping?.kind ?? "COPY",
    inputs: (mapping?.inputs ?? []).flatMap((i) => (i.kind === "missing" ? [] : [i])),
    separator: mapping?.separator ?? DEFAULT_SEPARATOR,
    splitMode: mapping?.splitRegex ? "pattern" : "separator",
    splitBy: mapping?.splitBy ?? "/",
    splitPart: String((mapping?.splitIndex ?? 0) + 1),
    splitRegex: mapping?.splitRegex ?? "",
    constantValue: mapping?.constantValue ?? "",
    expressionText: mapping?.expression ? expressionToDisplay(mapping.expression, (id) => nameFor.get(id) ?? null) : "",
    fillDown: mapping?.fillDown ?? true,
  };
}

function toDraft(columnId: string, s: EditorState, idFor: Map<string, string>): MappingDraft {
  const part = Number(s.splitPart);
  const splitting = s.kind === "SPLIT";
  return {
    outputColumnId: columnId,
    kind: s.kind,
    inputs: s.kind === "CONCAT" ? s.inputs : s.kind === "COPY" || s.kind === "SPLIT" ? s.inputs.slice(0, 1) : [],
    separator: s.kind === "CONCAT" ? s.separator : null,
    splitBy: splitting && s.splitMode === "separator" ? s.splitBy : null,
    splitIndex: splitting && s.splitMode === "separator" ? (Number.isInteger(part) && part >= 1 ? part - 1 : null) : null,
    splitRegex: splitting && s.splitMode === "pattern" ? s.splitRegex : null,
    constantValue: s.kind === "CONSTANT" ? s.constantValue : null,
    expression: s.kind === "EXPRESSION" ? expressionFromDisplay(s.expressionText, (name) => idFor.get(name) ?? null) : null,
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
  const current = value ? `${value.kind}:${value.id}` : undefined;
  const known = options.some((o) => o.value === current);
  return (
    <Select
      value={known ? current : undefined}
      onValueChange={(v) => {
        const o = options.find((x) => x.value === v);
        if (!o || v === current) return;
        onChange(o.kind === "field" ? { kind: "field", id: o.id } : { kind: "group", id: o.id, optionValues: {}, noneValue: null });
      }}
    >
      <SelectTrigger id={id} className="w-full" aria-label={id ? undefined : "Field"}>
        <SelectValue placeholder={value && !known ? "A deleted field: choose another" : "Choose a field or tick group"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span lang={lang} className="font-value">
              {o.path}
            </span>
            <span className="text-muted-foreground ml-2 text-xs">{o.detail}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function GroupOptionValues({
  source,
  tree,
  lang,
  onChange,
}: {
  source: Extract<MappingSourceInput, { kind: "group" }>;
  tree: SourceTree;
  lang: string | undefined;
  onChange: (source: MappingSourceInput) => void;
}) {
  const node = tree.groups.get(source.id);
  if (!node) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">Values to export</p>
      <p className="text-muted-foreground text-xs">
        Leave a value blank to export the option&apos;s label.
        {node.group.selection === "ANY_OF" ? " Several ticked options are joined with commas." : ""}
      </p>
      {selectionOptions(node).map((f) => {
        const label = optionLabel(tree, node.id, f.id);
        return (
          <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,10rem)] items-center gap-2">
            <span lang={lang} className="font-value truncate text-sm">
              {label}
            </span>
            <Input
              aria-label={`Value exported for ${label}`}
              value={source.optionValues[f.id] ?? ""}
              placeholder={label}
              onChange={(e) => onChange({ ...source, optionValues: { ...source.optionValues, [f.id]: e.target.value } })}
            />
          </div>
        );
      })}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,10rem)] items-center gap-2">
        <Label htmlFor={`none-${source.id}`} className="text-sm font-normal">
          When nothing is ticked, export
        </Label>
        <Input
          id={`none-${source.id}`}
          value={source.noneValue ?? ""}
          placeholder="Nothing"
          onChange={(e) => onChange({ ...source, noneValue: e.target.value === "" ? null : e.target.value })}
        />
      </div>
    </div>
  );
}

type EditorProps = {
  column: ColumnOption;
  mapping: MappingView | null;
  template: TemplateDetail;
  tree: SourceTree;
  options: SourceOption[];
  names: { nameFor: Map<string, string>; idFor: Map<string, string> };
  lang: string | undefined;
  onDraft: (draft: (MappingDraft & { id: string | null }) | null) => void;
  onCancel: () => void;
  onSaved: (mapping: MappingView) => void;
  onDelete: () => void;
};

function MappingEditor({ column, mapping, template, tree, options, names, lang, onDraft, onCancel, onSaved, onDelete }: EditorProps) {
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
  const missingInputs = mapping?.inputs.some((i) => i.kind === "missing") ?? false;

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
        <Select value={state.kind} onValueChange={(v) => set({ kind: MAPPING_KINDS.find((k) => k === v) ?? state.kind })}>
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

      {missingInputs ? <FormMessage tone="info">A tick group this mapping read was deleted. Choose what to read instead.</FormMessage> : null}

      {state.kind === "COPY" || state.kind === "SPLIT" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="mapping-source">Reads</Label>
          <SourcePicker
            id="mapping-source"
            value={single}
            options={state.kind === "SPLIT" ? options.filter((o) => o.kind === "field") : options}
            lang={lang}
            onChange={(s) => set({ inputs: [s] })}
          />
          {single?.kind === "group" && state.kind === "COPY" ? (
            <GroupOptionValues source={single} tree={tree} lang={lang} onChange={(s) => set({ inputs: [s] })} />
          ) : null}
        </div>
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
              {source.kind === "group" ? <GroupOptionValues source={source} tree={tree} lang={lang} onChange={(s) => setInput(i, s)} /> : null}
            </div>
          ))}
          <Select
            value=""
            onValueChange={(v) => {
              const o = options.find((x) => x.value === v);
              if (o) {
                const source: MappingSourceInput = o.kind === "field" ? { kind: "field", id: o.id } : { kind: "group", id: o.id, optionValues: {}, noneValue: null };
                set({ inputs: [...state.inputs, source] });
              }
            }}
          >
            <SelectTrigger className="w-full" aria-label="Add a field to join">
              <SelectValue placeholder="Add a field…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span lang={lang} className="font-value">
                    {o.path}
                  </span>
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
              const o = options.find((x) => x.value === v);
              if (o) set({ expressionText: `${state.expressionText}{${names.nameFor.get(o.id) ?? o.id}}` });
            }}
          >
            <SelectTrigger className="w-full" aria-label="Insert a field">
              <SelectValue placeholder="Insert a field…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span lang={lang} className="font-value">
                    {o.path}
                  </span>
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
  const name = (s: MappingView["inputs"][number]) =>
    s.kind === "missing" ? "a deleted tick group" : (options.find((o) => o.id === s.id)?.path ?? "a deleted field");
  switch (mapping.kind) {
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
  tree: SourceTree;
  lang: string | undefined;
  /** Reloads the template, so the config badge follows mapping changes. */
  onChanged: () => Promise<void>;
};

/** The mapping layer (docs/01 §6.5b, docs/05 §7): how fields become output columns, with a live preview. */
export function MappingTab({ template, tree, lang, onChanged }: Props) {
  const [overview, setOverview] = useState<MappingsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [draft, setDraft] = useState<(MappingDraft & { id: string | null }) | null>(null);
  const [deleting, setDeleting] = useState<{ mappingId: string; columnLabel: string } | null>(null);
  const [status, setStatus] = useState<RetransformStatus>({ state: "idle", done: 0, total: 0, lastRun: null });
  const [watching, setWatching] = useState(true);

  const options = useMemo(() => sourceOptions(tree), [tree]);
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

  // Fields and groups change what a mapping can read: reload when the source layer changes.
  useEffect(() => {
    void load();
  }, [load, template.fields, template.groups]);

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
      <FormMessage tone="error">{loadError}</FormMessage>
    ) : (
      <p className="text-muted-foreground py-10 text-center text-sm">Loading mappings…</p>
    );
  }

  const byColumn = new Map(overview.mappings.map((m) => [m.outputColumnId, m]));
  const mapped = overview.columns.filter((c) => byColumn.has(c.id));
  const unmapped = overview.columns.filter((c) => !byColumn.has(c.id));
  const used = new Set(overview.mappings.flatMap((m) => m.inputs.flatMap((i) => (i.kind === "missing" ? [] : [i.id]))));
  const unusedFields = options.filter((o) => o.kind === "field" && !used.has(o.id) && !template.fields.some((f) => f.id === o.id && f.mode === "SKIP"));
  const shownColumnIds = new Set([...mapped.map((c) => c.id), ...(editingColumn ? [editingColumn] : [])]);

  const renderEditor = (column: ColumnOption) => (
    <MappingEditor
      key={column.id}
      column={column}
      mapping={byColumn.get(column.id) ?? null}
      template={template}
      tree={tree}
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
            <p className="font-medium">The book has no output columns</p>
            <p className="text-muted-foreground text-sm">Add columns in the book&apos;s Settings, then map fields to them here.</p>
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
                  <span lang={lang} className="font-value">
                    {o.path}
                  </span>
                  <span className="text-muted-foreground ml-2 text-xs">{o.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-label="Preview" className="rounded-xl border p-4 lg:sticky lg:top-[calc(var(--top-bar-height)+1.5rem)]">
        <MappingPreviewPanel
          templateId={template.id}
          columns={overview.columns}
          shownColumnIds={shownColumnIds}
          draft={draft}
          focusColumnId={editingColumn}
          lang={lang}
        />
      </section>

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
