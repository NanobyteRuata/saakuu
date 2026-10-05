"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Pane, PaneGroup, PaneHandle } from "@/components/shell/pane";
import { Button } from "@/components/ui/button";
import { getJson, postJson } from "@/lib/api-client";
import { isoDate } from "@/lib/format";
import type { DateEra } from "@/lib/books/schemas";
import { langOf } from "@/lib/templates/labels";
import type { TemplateDetail } from "@/lib/templates/service";
import { buildTree, formatPath, headerPath, sameRef, type SiblingRef } from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";
import { useLayoutTarget } from "@/lib/ui/breakpoint";
import { PHOTO_MIN_PX } from "@/lib/ui/panes";

import type { Flush } from "./autosave";
import { DeleteFieldDialog } from "./delete-field-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { FieldProperties, type FieldDraft } from "./field-properties";
import { FieldTree } from "./field-tree";
import { GroupProperties, type GroupDraft } from "./group-properties";
import { SpecimenPane } from "./specimen-pane";
import { TemplateChrome } from "./template-chrome";

/** 24rem: the field tree stops being readable much below this, labels being in their own script. */
const TREE_MIN_PX = 384;
/** The densest form in the app — source label, meaning, type, mode, note, choices, marks. */
const PROPERTIES_MIN_PX = 360;

/**
 * The Fields workspace (docs/05 §7, docs/06 Phase 15).
 *
 * The paper is on screen beside the tree the whole time. Until Phase 15 this was the screen where
 * the operator typed the most — twenty Burmese labels transcribed off a page on the desk — with no
 * image on it at all, while review, which types the least, had one. Two panes at 1280 with the
 * properties opening under the selected row; three at 1600, properties in their own.
 */
export function TemplateEditor({
  initial,
  userId,
  bookDefaultModel,
  bookDateEra,
}: {
  initial: TemplateDetail;
  /** Pane sizes are remembered per workspace per user (docs/05 §0). */
  userId: string;
  bookDefaultModel: string;
  bookDateEra: DateEra;
}) {
  const router = useRouter();
  const [template, setTemplate] = useState(initial);
  const [selected, setSelected] = useState<SiblingRef | null>(null);
  const [toDelete, setToDelete] = useState<FieldView | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<GroupView | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const layout = useLayoutTarget();
  const lang = langOf(template.languageHint);
  const tree = useMemo(() => buildTree(template.groups, template.fields), [template.groups, template.fields]);
  // Local edits don't refresh `fieldsChangedAt`, so the specimen pane also watches the fields themselves.
  const fieldsKey = useMemo(() => {
    const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
    return JSON.stringify([[...template.fields].sort(byId), [...template.groups].sort(byId)]);
  }, [template.groups, template.fields]);
  const selectedField = selected?.kind === "field" ? (template.fields.find((f) => f.id === selected.id) ?? null) : null;
  const selectedGroup = selected?.kind === "group" ? (template.groups.find((g) => g.id === selected.id) ?? null) : null;

  /*
   * Autosave, not save-and-discard (decision 72). The open form registers a flush here, so switching
   * fields saves the one being left. Anything that will not save stays in these draft maps with its
   * message and is restored on return, which is why no modal is needed to protect it.
   */
  const flushRef = useRef<Flush | null>(null);
  const registerFlush = useCallback((flush: Flush | null) => {
    flushRef.current = flush;
  }, []);
  const fieldDrafts = useRef(new Map<string, FieldDraft>()).current;
  const groupDrafts = useRef(new Map<string, GroupDraft>()).current;

  const reload = useCallback(async () => {
    const result = await getJson<TemplateDetail>(`/api/templates/${template.id}`);
    if (result.ok) setTemplate(result.data);
    else toast.error(result.error.message);
  }, [template.id]);

  const requestSelect = useCallback(
    (ref: SiblingRef) => {
      if (sameRef(ref, selected)) return;
      const flush = flushRef.current;
      setSelected(ref);
      void flush?.();
    },
    [selected],
  );

  function clearSelection() {
    setSelected(null);
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
    setSelected({ kind: "field", id: result.data.field.id });
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

  const properties = selectedField ? (
    <FieldProperties
      key={selectedField.id}
      field={selectedField}
      template={template}
      tree={tree}
      lang={lang}
      bookDateEra={bookDateEra}
      drafts={fieldDrafts}
      registerFlush={registerFlush}
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
      drafts={groupDrafts}
      registerFlush={registerFlush}
      onSaved={(group) => setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === group.id ? group : g)) }))}
      onDelete={() => setGroupToDelete(selectedGroup)}
    />
  ) : null;

  const treePane = (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <FieldTree
        template={template}
        tree={tree}
        setTemplate={setTemplate}
        selected={selected}
        onSelect={requestSelect}
        onDeleteGroup={setGroupToDelete}
        reload={reload}
        lang={lang}
        // Below three panes the properties open under the row they belong to, rather than in a
        // permanent narrow column that would starve the densest form in the app (docs/06 Phase 15).
        renderDetail={layout === "three" ? undefined : (ref) => (sameRef(ref, selected) ? properties : null)}
      />
      {template.deletedFields.length > 0 ? (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Deleted fields ({template.deletedFields.length})</summary>
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
                <Button size="sm" variant="outline" onClick={() => restore(f)} disabled={restoring !== null} aria-label={`Restore ${f.labelSource}`}>
                  <RotateCcw />
                  {restoring === f.id ? "Restoring…" : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );

  return (
    <TemplateChrome template={template} bookDefaultModel={bookDefaultModel} active="fields" onTemplate={setTemplate}>
      {/*
       * The layout target is part of the key: two panes and three are different shapes, so they
       * remember their splits separately instead of one overwriting the other.
       */}
      <PaneGroup workspace={layout === "three" ? "template-3" : "template-2"} userId={userId}>
        <Pane id="photo" defaultSize={layout === "three" ? "40%" : "48%"} minSize={PHOTO_MIN_PX} collapsible>
          <SpecimenPane
            bookId={template.bookId}
            templateId={template.id}
            templateName={template.name}
            templateKind={template.kind}
            userId={userId}
            lang={lang}
            hasExtractFields={template.fields.some((f) => f.mode === "EXTRACT")}
            fieldsChangedAt={template.fieldsChangedAt}
            fieldsKey={fieldsKey}
            flushPending={async () => {
              await flushRef.current?.();
            }}
            onFieldsAdded={() => void reload()}
            onRead={() => {
              void reload();
              // A reading changes the book's row and review counts, which the workspace nav renders.
              router.refresh();
            }}
          />
        </Pane>
        <PaneHandle />
        <Pane id="fields" defaultSize={layout === "three" ? "34%" : "52%"} minSize={TREE_MIN_PX}>
          {treePane}
        </Pane>
        {layout === "three" ? (
          <>
            <PaneHandle />
            <Pane id="properties" defaultSize="26%" minSize={PROPERTIES_MIN_PX} collapsible>
              <section aria-label="Properties" className="min-h-0 flex-1 overflow-y-auto p-4">
                {properties ?? (
                  <div className="flex flex-col gap-1 py-10 text-center">
                    <p className="font-medium">Nothing selected</p>
                    <p className="text-muted-foreground text-sm">
                      {template.fields.length === 0
                        ? "Add the first field in the middle: type its label exactly as it's written on the page."
                        : "Choose a field to set its meaning, type, mode and a note for the AI, or a group to set how its tick columns are read."}
                    </p>
                  </div>
                )}
              </section>
            </Pane>
          </>
        ) : null}
      </PaneGroup>

      <DeleteFieldDialog
        field={toDelete}
        lang={lang}
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        onDeleted={async (field) => {
          if (sameRef(selected, { kind: "field", id: field.id })) clearSelection();
          fieldDrafts.delete(field.id);
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
          groupDrafts.delete(group.id);
          await reload();
          toast.success(`Deleted the group “${group.labelSource}”. ${summary}`);
        }}
      />
    </TemplateChrome>
  );
}
