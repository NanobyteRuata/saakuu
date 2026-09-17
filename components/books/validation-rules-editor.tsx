"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormMessage } from "@/components/auth/form-message";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteJson, getJson, patchJson, postJson } from "@/lib/api-client";
import type { ColumnType } from "@/lib/books/schemas";
import { formatCount, plural } from "@/lib/format";
import {
  COMPARE_OPERATORS,
  OFFERED_RULE_KINDS,
  OPERATOR_LABELS,
  RULE_KIND_LABELS,
  type CompareOperator,
  type RuleDraft,
  type RuleKind,
  type RuleSeverity,
} from "@/lib/validation/rules";
import type { RuleView } from "@/lib/validation/rules-service";

type Column = { id: string; label: string; dataType: ColumnType };

type Props = { bookId: string; columns: Column[]; initial: RuleView[] };

const PREVIEW_DEBOUNCE_MS = 400;

/** Plain-language summary of a rule's settings, for the list. */
function describe(rule: RuleDraft, columns: Map<string, Column>): string {
  switch (rule.kind) {
    case "REQUIRED":
      return "must not be empty";
    case "TYPE":
      return "must match the column type";
    case "RANGE": {
      const { min, max } = rule.params;
      return min && max ? `between ${min} and ${max}` : min ? `at least ${min}` : `at most ${max ?? ""}`;
    }
    case "LENGTH": {
      const { min, max } = rule.params;
      return min !== null && max !== null ? `${min}–${max} characters` : min !== null ? `at least ${min} characters` : `at most ${max ?? 0} characters`;
    }
    case "REGEX":
      return `matches ${rule.params.pattern}`;
    case "ENUM":
      return `one of ${rule.params.values.join(", ")}`;
    case "UNIQUE":
      return "no two rows share a value";
    case "CROSS_COLUMN":
      return `${OPERATOR_LABELS[rule.params.operator]} ${columns.get(rule.params.otherColumnId)?.label ?? "a deleted column"}`;
    case "MONOTONIC":
      return rule.params.strict ? "goes up row by row within a document" : "never goes down within a document";
  }
}

type FormState = {
  outputColumnId: string;
  kind: Exclude<RuleKind, "TYPE">;
  severity: RuleSeverity;
  message: string;
  enabled: boolean;
  min: string;
  max: string;
  pattern: string;
  values: string;
  otherColumnId: string;
  operator: CompareOperator;
  strict: boolean;
};

function toForm(rule: RuleView | null, columns: Column[]): FormState {
  const base: FormState = {
    outputColumnId: rule?.outputColumnId ?? columns[0]?.id ?? "",
    kind: rule && rule.kind !== "TYPE" ? rule.kind : "RANGE",
    severity: rule?.severity ?? "WARNING",
    message: rule?.message ?? "",
    enabled: rule?.enabled ?? true,
    min: "",
    max: "",
    pattern: "",
    values: "",
    otherColumnId: "",
    operator: "GTE",
    strict: false,
  };
  if (!rule) return base;
  switch (rule.kind) {
    case "RANGE":
      return { ...base, min: rule.params.min ?? "", max: rule.params.max ?? "" };
    case "LENGTH":
      return { ...base, min: rule.params.min === null ? "" : String(rule.params.min), max: rule.params.max === null ? "" : String(rule.params.max) };
    case "REGEX":
      return { ...base, pattern: rule.params.pattern };
    case "ENUM":
      return { ...base, values: rule.params.values.join("\n") };
    case "CROSS_COLUMN":
      return { ...base, otherColumnId: rule.params.otherColumnId, operator: rule.params.operator };
    case "MONOTONIC":
      return { ...base, strict: rule.params.strict };
    default:
      return base;
  }
}

/** The draft to send, or a plain message saying what's missing. */
function toDraft(f: FormState): RuleDraft | string {
  const common = { outputColumnId: f.outputColumnId, severity: f.severity, message: f.message.trim() || null, enabled: f.enabled };
  if (!f.outputColumnId) return "Choose a column.";
  switch (f.kind) {
    case "REQUIRED":
    case "UNIQUE":
      return { ...common, kind: f.kind, params: {} };
    case "RANGE":
      return { ...common, kind: "RANGE", params: { min: f.min.trim() || null, max: f.max.trim() || null } };
    case "LENGTH": {
      const n = (v: string) => (v.trim() === "" ? null : Number(v));
      const min = n(f.min);
      const max = n(f.max);
      if ((min !== null && !Number.isInteger(min)) || (max !== null && !Number.isInteger(max))) return "Lengths are whole numbers.";
      return { ...common, kind: "LENGTH", params: { min, max } };
    }
    case "REGEX":
      return f.pattern ? { ...common, kind: "REGEX", params: { pattern: f.pattern } } : "Enter a pattern.";
    case "ENUM": {
      const values = f.values.split("\n").map((v) => v.trim()).filter(Boolean);
      return values.length > 0 ? { ...common, kind: "ENUM", params: { values } } : "Add at least one allowed value, one per line.";
    }
    case "CROSS_COLUMN":
      return f.otherColumnId ? { ...common, kind: "CROSS_COLUMN", params: { otherColumnId: f.otherColumnId, operator: f.operator } } : "Choose the column to compare with.";
    case "MONOTONIC":
      return { ...common, kind: "MONOTONIC", params: { strict: f.strict } };
  }
}

function RuleForm({ bookId, columns, rule, onSaved, onCancel }: { bookId: string; columns: Column[]; rule: RuleView | null; onSaved: (rule: RuleView) => void; onCancel: () => void }) {
  const [form, setForm] = useState<FormState>(() => toForm(rule, columns));
  const [preview, setPreview] = useState<{ failing: number; problem: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const draft = toDraft(form);
  const draftKey = JSON.stringify(draft);
  const column = columns.find((c) => c.id === form.outputColumnId);
  const dateColumn = column?.dataType === "DATE";

  useEffect(() => {
    const parsed: unknown = JSON.parse(draftKey);
    if (typeof parsed === "string") {
      setPreview({ failing: 0, problem: parsed });
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void postJson<{ failing: number; problem: string | null }>(`/api/books/${bookId}/rules/preview`, parsed).then((result) => {
        if (cancelled) return;
        setPreview(result.ok ? result.data : { failing: 0, problem: result.error.message });
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [bookId, draftKey]);

  async function save() {
    if (typeof draft === "string") {
      setError(draft);
      return;
    }
    setPending(true);
    const result = rule ? await patchJson<RuleView>(`/api/books/${bookId}/rules/${rule.id}`, draft) : await postJson<RuleView>(`/api/books/${bookId}/rules`, draft);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved(result.data);
  }

  return (
    <div className="bg-muted/30 flex flex-col gap-4 rounded-lg border p-4" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-column">Column</Label>
          <Select value={form.outputColumnId} onValueChange={(v) => set({ outputColumnId: v })}>
            <SelectTrigger id="rule-column" className="w-full">
              <SelectValue placeholder="Choose a column" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-kind">Check</Label>
          <Select value={form.kind} onValueChange={(v) => set({ kind: v as FormState["kind"] })}>
            <SelectTrigger id="rule-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OFFERED_RULE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {RULE_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-severity">When it fails</Label>
          <Select value={form.severity} onValueChange={(v) => set({ severity: v === "ERROR" ? "ERROR" : "WARNING" })}>
            <SelectTrigger id="rule-severity" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="WARNING">Warning (worth a look)</SelectItem>
              <SelectItem value="ERROR">Error (wrong data)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.kind === "RANGE" || form.kind === "LENGTH" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-min">{form.kind === "LENGTH" ? "Shortest (characters)" : dateColumn ? "Earliest date" : "Minimum"}</Label>
            <Input id="rule-min" value={form.min} onChange={(e) => set({ min: e.target.value })} placeholder={dateColumn && form.kind === "RANGE" ? "YYYY-MM-DD" : "none"} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-max">{form.kind === "LENGTH" ? "Longest (characters)" : dateColumn ? "Latest date" : "Maximum"}</Label>
            <Input id="rule-max" value={form.max} onChange={(e) => set({ max: e.target.value })} placeholder={dateColumn && form.kind === "RANGE" ? "YYYY-MM-DD" : "none"} />
          </div>
        </div>
      ) : null}
      {form.kind === "REGEX" ? (
        <div className="flex max-w-md flex-col gap-2">
          <Label htmlFor="rule-pattern">Pattern (regular expression)</Label>
          <Input id="rule-pattern" className="font-mono" value={form.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="^\d{2}/\d{4}$" />
        </div>
      ) : null}
      {form.kind === "ENUM" ? (
        <div className="flex max-w-md flex-col gap-2">
          <Label htmlFor="rule-values">Allowed values, one per line</Label>
          <textarea id="rule-values" className="font-value border-input min-h-24 rounded-md border bg-transparent px-3 py-2 text-sm" value={form.values} onChange={(e) => set({ values: e.target.value })} />
        </div>
      ) : null}
      {form.kind === "CROSS_COLUMN" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-operator">The value should be</Label>
            <Select value={form.operator} onValueChange={(v) => set({ operator: COMPARE_OPERATORS.find((o) => o === v) ?? form.operator })}>
              <SelectTrigger id="rule-operator" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPARE_OPERATORS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {OPERATOR_LABELS[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-other">the value in</Label>
            <Select value={form.otherColumnId} onValueChange={(v) => set({ otherColumnId: v })}>
              <SelectTrigger id="rule-other" className="w-full">
                <SelectValue placeholder="Choose a column" />
              </SelectTrigger>
              <SelectContent>
                {columns
                  .filter((c) => c.id !== form.outputColumnId)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
      {form.kind === "MONOTONIC" ? (
        <div className="flex items-center gap-2">
          <Checkbox id="rule-strict" checked={form.strict} onCheckedChange={(v) => set({ strict: v === true })} />
          <Label htmlFor="rule-strict" className="font-normal">
            Each row must be higher than the one above (repeats fail too)
          </Label>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="rule-message">Message shown on failing cells (optional)</Label>
          <Input id="rule-message" value={form.message} onChange={(e) => set({ message: e.target.value })} placeholder="A plain explanation is written for you if left blank" />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Checkbox id="rule-enabled" checked={form.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
          <Label htmlFor="rule-enabled" className="font-normal">
            Enabled
          </Label>
        </div>
      </div>

      <p className="text-sm" aria-live="polite">
        {preview === null ? (
          <span className="text-muted-foreground">Counting cells…</span>
        ) : preview.problem ? (
          <span className="text-destructive">{preview.problem}</span>
        ) : (
          <span>
            {preview.failing === 0 ? "No existing cells fail this rule." : `${formatCount(preview.failing)} existing ${preview.failing === 1 ? "cell fails" : "cells fail"} this rule.`}
          </span>
        )}
      </p>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={pending || (preview?.problem ?? null) !== null}>
          {pending ? "Saving and checking cells…" : rule ? "Save rule" : "Add rule"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Validation rules for the book's columns (docs/01 §16), with how many cells each flags right now. */
export function ValidationRulesEditor({ bookId, columns, initial }: Props) {
  const router = useRouter();
  const [rules, setRules] = useState(initial);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<RuleView | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const pollRef = useRef<number | null>(null);
  const byId = new Map(columns.map((c) => [c.id, c]));

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current);
  }, []);

  // Counts read every cell of the book, so they load after the page instead of holding it up.
  useEffect(() => {
    if (initial.length === 0) return;
    let cancelled = false;
    void getJson<RuleView[]>(`/api/books/${bookId}/rules`).then((result) => {
      if (!cancelled && result.ok) setRules(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [bookId, initial.length]);

  function saved(rule: RuleView) {
    setRules((prev) => (prev.some((r) => r.id === rule.id) ? prev.map((r) => (r.id === rule.id ? rule : r)) : [...prev, rule]));
    setEditing(null);
    toast.success(!rule.failing ? "Rule saved. No cells fail it." : `Rule saved. ${plural(rule.failing, "cell")} now flagged in the table.`);
    router.refresh();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletePending(true);
    const result = await deleteJson<{ deleted: true }>(`/api/books/${bookId}/rules/${deleting.id}`);
    setDeletePending(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setRules((prev) => prev.filter((r) => r.id !== deleting.id));
    setDeleting(null);
    toast.success("Rule deleted.");
  }

  async function recheck() {
    setRechecking(true);
    const started = await postJson<{ pending: boolean }>(`/api/books/${bookId}/rules/revalidate`, {});
    if (!started.ok) {
      setRechecking(false);
      toast.error(started.error.message);
      return;
    }
    const poll = async () => {
      const status = await getJson<{ pending: boolean }>(`/api/books/${bookId}/rules/revalidate`);
      if (status.ok && status.data.pending) {
        pollRef.current = window.setTimeout(() => void poll(), 2000);
        return;
      }
      setRechecking(false);
      const list = await getJson<RuleView[]>(`/api/books/${bookId}/rules`);
      if (list.ok) setRules(list.data);
      toast.success("Every cell has been checked again.");
    };
    pollRef.current = window.setTimeout(() => void poll(), 1000);
  }

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 && editing !== "new" ? (
        <p className="text-muted-foreground text-sm">
          No rules yet. Rules catch plausible-looking wrong values, like a date after today or an age over 120. They flag cells; they never block export.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rules.map((rule) =>
          editing === rule.id ? (
            <li key={rule.id}>
              <RuleForm bookId={bookId} columns={columns} rule={rule} onSaved={saved} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
              <span className="font-medium">{byId.get(rule.outputColumnId)?.label ?? "Deleted column"}</span>
              <span className="text-sm">
                {RULE_KIND_LABELS[rule.kind]}: {describe(rule, byId)}
              </span>
              <Badge variant={rule.severity === "ERROR" ? "destructive" : "outline"}>{rule.severity === "ERROR" ? "Error" : "Warning"}</Badge>
              {!rule.enabled ? <Badge variant="secondary">Off</Badge> : null}
              <span className="text-muted-foreground text-sm">
                {rule.problem ? (
                  <span className="text-destructive">{rule.problem}</span>
                ) : !rule.enabled ? (
                  "not checked while off"
                ) : rule.failing === null ? (
                  "counting…"
                ) : (
                  `${formatCount(rule.failing)} ${rule.failing === 1 ? "cell fails" : "cells fail"}`
                )}
              </span>
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(rule.id)} disabled={editing !== null}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(rule)} disabled={editing !== null}>
                  Delete
                </Button>
              </span>
            </li>
          ),
        )}
      </ul>
      {editing === "new" ? (
        <RuleForm bookId={bookId} columns={columns} rule={null} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditing("new")} disabled={editing !== null || columns.length === 0}>
            Add rule
          </Button>
          <Button variant="ghost" onClick={() => void recheck()} disabled={rechecking}>
            {rechecking ? "Checking every cell…" : "Re-check all cells"}
          </Button>
        </div>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !deletePending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.failing
                ? `It currently flags ${plural(deleting.failing, "cell")}. Those flags are removed; no values change.`
                : "It flags no cells right now. No values change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deletePending}>
              {deletePending ? "Deleting…" : "Delete rule"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
