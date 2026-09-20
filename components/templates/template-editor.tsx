"use client";

import { RotateCcw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
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
import type { DateEra } from "@/lib/books/schemas";
import { langOf } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { buildTree, formatPath, headerPath, sameRef, type SiblingRef } from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";

import { TryOneDocument } from "@/components/documents/try-one-document";

import { DeleteFieldDialog } from "./delete-field-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { FieldProperties } from "./field-properties";
import { FieldTree } from "./field-tree";
import { GroupProperties } from "./group-properties";
import { TemplateChrome } from "./template-chrome";

export function TemplateEditor({
  initial,
  bookDefaultModel,
  bookDateEra,
}: {
  initial: TemplateDetail;
  bookDefaultModel: string;
  bookDateEra: DateEra;
}) {
  const router = useRouter();
  const [template, setTemplate] = useState(initial);
  const [selected, setSelected] = useState<SiblingRef | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<SiblingRef | null>(null);
  const [toDelete, setToDelete] = useState<FieldView | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<GroupView | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
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
    <TemplateChrome template={template} bookDefaultModel={bookDefaultModel} active="fields" onTemplate={setTemplate}>
      <div className="grid items-start gap-6 lg:grid-cols-2">
          <section aria-label="Field list" className="flex flex-col gap-4">
            {template.fields.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                <p className="text-muted-foreground text-sm">
                  Read one page with these fields before uploading the rest — it shows what the AI makes of this paper.
                </p>
                <Button size="sm" variant="outline" onClick={() => setTrying(true)}>
                  <Sparkles />
                  Try one document
                </Button>
              </div>
            ) : null}
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

          <section aria-label="Properties" className="rounded-xl border p-4 lg:sticky lg:top-6">
            {selectedField ? (
              <FieldProperties
                key={selectedField.id}
                field={selectedField}
                template={template}
                tree={tree}
                lang={lang}
                bookDateEra={bookDateEra}
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

      <TryOneDocument
        bookId={template.bookId}
        templateId={template.id}
        templateName={template.name}
        lang={lang}
        open={trying}
        onOpenChange={setTrying}
        onExtracted={() => {
          void reload();
          // A reading changes the book's row and review counts, which the workspace nav renders.
          router.refresh();
        }}
      />

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
    </TemplateChrome>
  );
}
