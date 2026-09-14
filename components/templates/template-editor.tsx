"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { getJson, postJson } from "@/lib/api-client";
import { isoDate } from "@/lib/format";
import { langOf } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { buildTree, formatPath, headerPath, sameRef, type SiblingRef } from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";
import { cn } from "@/lib/utils";

import { DeleteFieldDialog } from "./delete-field-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { DuplicateTemplateDialog } from "./duplicate-template-dialog";
import { FieldProperties } from "./field-properties";
import { FieldTree } from "./field-tree";
import { GroupProperties } from "./group-properties";
import { TemplateHeaderForm } from "./template-header-form";

const TABS = [
  { id: "fields", label: "Fields" },
  { id: "mapping", label: "Mapping" },
  { id: "validation", label: "Validation" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export function TemplateEditor({ initial, bookDefaultModel }: { initial: TemplateDetail; bookDefaultModel: string }) {
  const [template, setTemplate] = useState(initial);
  const [tab, setTab] = useState<Tab>("fields");
  const [selected, setSelected] = useState<SiblingRef | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<SiblingRef | null>(null);
  const [toDelete, setToDelete] = useState<FieldView | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<GroupView | null>(null);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const lang = langOf(template.languageHint);
  const tree = useMemo(() => buildTree(template.groups, template.fields), [template.groups, template.fields]);
  const selectedField = selected?.kind === "field" ? (template.fields.find((f) => f.id === selected.id) ?? null) : null;
  const selectedGroup = selected?.kind === "group" ? (template.groups.find((g) => g.id === selected.id) ?? null) : null;

  const reload = useCallback(async () => {
    const result = await getJson<TemplateDetail>(`/api/templates/${template.id}`);
    if (result.ok) setTemplate(result.data);
    else toast.error(result.error.message);
  }, [template.id]);

  // A save that finishes while the discard prompt is open leaves nothing to discard: just switch.
  useEffect(() => {
    if (pendingSelect !== null && !dirty) {
      setSelected(pendingSelect);
      setPendingSelect(null);
    }
  }, [pendingSelect, dirty]);

  function requestSelect(ref: SiblingRef) {
    if (sameRef(ref, selected)) return;
    if (dirty) setPendingSelect(ref);
    else setSelected(ref);
  }

  function clearSelection() {
    setSelected(null);
    setDirty(false);
  }

  async function restore(field: { id: string; labelSource: string }) {
    setRestoring(field.id);
    const result = await postJson<{ field: FieldView; sequenceRestored: boolean; placedOutside: boolean }>(
      `/api/fields/${field.id}/restore`,
      {},
    );
    setRestoring(null);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    await reload();
    if (!dirty) setSelected({ kind: "field", id: result.data.field.id });
    toast.success(
      `Restored “${result.data.field.labelSource}”.${result.data.sequenceRestored ? " It's the sequence field again." : ""}${
        result.data.placedOutside ? " Its group only takes Mark / tick fields now, so it's placed just after that group." : ""
      }`,
    );
  }

  function deletedFieldPath(f: FieldView): string {
    if (f.groupId === null || !tree.groups.has(f.groupId)) return "";
    return `${formatPath(headerPath(tree, { kind: "group", id: f.groupId }))} › `;
  }

  const pendingLabel = selectedField?.labelSource ?? selectedGroup?.labelSource;

  return (
    <div className="flex flex-col gap-6">
      <TemplateHeaderForm
        template={template}
        bookDefaultModel={bookDefaultModel}
        onSaved={setTemplate}
        onDuplicate={() => setDuplicateOpen(true)}
      />

      <div role="tablist" aria-label="Template sections" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              tab === t.id ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "fields" ? (
        <div role="tabpanel" id="panel-fields" aria-labelledby="tab-fields" className="grid items-start gap-6 lg:grid-cols-2">
          <section aria-label="Field list" className="flex flex-col gap-4">
            <FieldTree
              template={template}
              tree={tree}
              setTemplate={setTemplate}
              selected={selected}
              onSelect={requestSelect}
              onDeleteGroup={setGroupToDelete}
              reload={reload}
              lang={lang}
            />
            {template.deletedFields.length > 0 ? (
              <details className="rounded-lg border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  Deleted fields ({template.deletedFields.length})
                </summary>
                <ul className="divide-y border-t" aria-label="Deleted fields">
                  {template.deletedFields.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p lang={lang} className="font-value truncate">
                          <span className="text-muted-foreground">{deletedFieldPath(f)}</span>
                          {f.labelSource}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {f.labelMeaning ? `${f.labelMeaning} · ` : ""}deleted {isoDate(f.deletedAt)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => restore(f)}
                        disabled={restoring !== null}
                        aria-label={`Restore ${f.labelSource}`}
                      >
                        <RotateCcw />
                        {restoring === f.id ? "Restoring…" : "Restore"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          <section aria-label="Properties" className="rounded-xl border p-4 lg:sticky lg:top-[calc(var(--top-bar-height)+1.5rem)]">
            {selectedField ? (
              <FieldProperties
                key={selectedField.id}
                field={selectedField}
                template={template}
                tree={tree}
                lang={lang}
                onDirtyChange={setDirty}
                onSaved={(field) => setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === field.id ? field : f)) }))}
                onTemplate={setTemplate}
                onDelete={() => setToDelete(selectedField)}
              />
            ) : selectedGroup ? (
              <GroupProperties
                key={selectedGroup.id}
                group={selectedGroup}
                template={template}
                tree={tree}
                lang={lang}
                onDirtyChange={setDirty}
                onSaved={(group) => setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === group.id ? group : g)) }))}
                onDelete={() => setGroupToDelete(selectedGroup)}
              />
            ) : (
              <div className="flex flex-col gap-1 py-10 text-center">
                <p className="font-medium">Nothing selected</p>
                <p className="text-muted-foreground text-sm">
                  {template.fields.length === 0
                    ? "Add the first field on the left: type its label exactly as it's written on the paper."
                    : "Choose a field to set its meaning, type, mode and a note for the AI, or a group to set how its tick columns are read."}
                </p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <p className="font-medium">{tab === "mapping" ? "Mapping arrives in a later update" : "Validation arrives in a later update"}</p>
          <p className="text-muted-foreground max-w-md text-sm">
            {tab === "mapping"
              ? "Here you'll connect each field to an output column, and preview the result on a real document before running anything."
              : "Here you'll override the book's validation rules for documents read with this template."}
          </p>
        </div>
      )}

      <DeleteFieldDialog
        field={toDelete}
        lang={lang}
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        onDeleted={async (field) => {
          if (sameRef(selected, { kind: "field", id: field.id })) clearSelection();
          await reload();
          toast.success(`Deleted “${field.labelSource}”. Its values are kept.`, {
            action: { label: "Restore", onClick: () => void restore(field) },
          });
        }}
      />

      <DeleteGroupDialog
        group={groupToDelete}
        lang={lang}
        open={groupToDelete !== null}
        onOpenChange={(open) => !open && setGroupToDelete(null)}
        onDeleted={async (group, summary) => {
          if (sameRef(selected, { kind: "group", id: group.id })) clearSelection();
          await reload();
          toast.success(`Deleted the group “${group.labelSource}”. ${summary}`);
        }}
      />

      <DuplicateTemplateDialog
        bookId={template.bookId}
        template={template}
        initialKind={template.kind === "FORM" ? "TABLE" : "FORM"}
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
      />

      <AlertDialog open={pendingSelect !== null} onOpenChange={(open) => !open && setPendingSelect(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You changed “{pendingLabel}” without saving. Discard those changes and open the other item?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep editing</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setDirty(false);
                setSelected(pendingSelect);
                setPendingSelect(null);
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
