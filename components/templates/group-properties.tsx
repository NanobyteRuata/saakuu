"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { patchJson } from "@/lib/api-client";
import { pickOption } from "@/lib/books/labels";
import { plural } from "@/lib/format";
import {
  GROUP_SELECTION_HINTS,
  GROUP_SELECTION_LABELS,
  MULTIPLE_MARKED_HINTS,
  MULTIPLE_MARKED_LABELS,
  NONE_MARKED_HINTS,
  NONE_MARKED_LABELS,
} from "@/lib/templates/labels";
import {
  GROUP_SELECTIONS,
  MULTIPLE_MARKED,
  NONE_MARKED,
  type GroupSelection,
  type MultipleMarked,
  type NoneMarked,
} from "@/lib/templates/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import {
  buildTree,
  childrenOf,
  descendants,
  formatPath,
  headerPath,
  moveProblem,
  selectionOptions,
  selectionProblem,
  type Tree,
} from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";

import { useAutosaveForm, type Flush } from "./autosave";
import { ParentGroupSelect } from "./parent-group-select";

export type GroupDraft = {
  labelSource: string;
  labelMeaning: string;
  selection: GroupSelection;
  noneMarked: NoneMarked;
  multipleMarked: MultipleMarked;
  note: string;
};

function toDraft(g: GroupView): GroupDraft {
  return {
    labelSource: g.labelSource,
    labelMeaning: g.labelMeaning ?? "",
    selection: g.selection,
    noneMarked: g.noneMarked,
    multipleMarked: g.multipleMarked,
    note: g.note ?? "",
  };
}

function toPayload(d: GroupDraft) {
  return {
    labelSource: d.labelSource.trim(),
    labelMeaning: d.labelMeaning.trim() || null,
    selection: d.selection,
    noneMarked: d.noneMarked,
    multipleMarked: d.multipleMarked,
    note: d.note.trim() || null,
  };
}

type Props = {
  group: GroupView;
  template: TemplateDetail;
  tree: Tree<GroupView, FieldView>;
  lang: string | undefined;
  onSaved: (group: GroupView) => void;
  onDelete: () => void;
  /** Drafts the parent holds, so a draft that will not save survives a click elsewhere (decision 72). */
  drafts: Map<string, GroupDraft>;
  registerFlush?: (flush: Flush | null) => void;
};

/** A header on the paper: labels, parent, selection settings and a note for the AI (docs/05, Phase 3.1). */
export function GroupProperties({ group, template, tree, lang, onSaved, onDelete, drafts, registerFlush }: Props) {
  const [draft, setDraft] = useState(() => drafts.get(group.id) ?? toDraft(group));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [moving, setMoving] = useState(false);

  const dirty = JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(toDraft(group)));
  const set = (patch: Partial<GroupDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // An unsaved draft is kept by the parent, so leaving this group and coming back loses nothing.
  useEffect(() => {
    if (dirty) drafts.set(group.id, draft);
    else drafts.delete(group.id);
  }, [dirty, draft, drafts, group.id]);

  const node = tree.groups.get(group.id);
  const path = headerPath(tree, { kind: "group", id: group.id });
  const inside = node ? descendants(node) : [];
  // The selection as drafted, checked against the current fields before anything is saved.
  const preview = buildTree(
    template.groups.map((g) => (g.id === group.id ? { ...g, selection: draft.selection } : g)),
    template.fields,
  );
  const previewNode = preview.groups.get(group.id);
  const options = previewNode ? selectionOptions(previewNode) : [];
  const draftIssue = selectionProblem(preview, group.id);
  const savedIssue = selectionProblem(tree, group.id);

  // The flush the parent calls must be stable, and must still see what is in the form right now.
  const latest = useRef({ draft, draftIssue, savedIssue });
  latest.current = { draft, draftIssue, savedIssue };

  const save = useCallback(async () => {
    const current = latest.current;
    if (!current.draft.labelSource.trim()) {
      setError("Enter the header as it's written on the paper.");
      return;
    }
    if (current.draftIssue && !current.savedIssue) {
      setError(current.draftIssue);
      return;
    }
    setPending(true);
    const result = await patchJson<GroupView>(`/api/groups/${group.id}`, toPayload(current.draft));
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setDraft(toDraft(result.data));
    onSaved(result.data);
  }, [group.id, onSaved]);

  const { onBlur } = useAutosaveForm({ dirty, save, registerFlush });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void save();
  }

  async function moveTo(parentId: string | null) {
    if (parentId === group.parentGroupId) return;
    const last = childrenOf(tree, parentId)
      .filter((n) => !(n.kind === "group" && n.id === group.id))
      .at(-1);
    setMoving(true);
    const result = await patchJson<GroupView>(`/api/groups/${group.id}`, {
      move: { parentGroupId: parentId, after: last ? { kind: last.kind, id: last.id } : null },
    });
    setMoving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    onSaved(result.data);
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  }

  const fieldCount = inside.filter((n) => n.kind === "field").length;
  const groupCount = inside.length - fieldCount;

  return (
    <form onSubmit={onSubmit} onBlur={onBlur} onKeyDown={onKeyDown} className="flex flex-col gap-4" noValidate aria-label="Group properties form">
      <div className="flex flex-col gap-0.5">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Group</p>
        {path.length > 1 ? (
          <p lang={lang} className="font-value text-muted-foreground text-sm">
            {formatPath(path)}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          Contains {plural(fieldCount, "field")}
          {groupCount > 0 ? ` and ${plural(groupCount, "sub-group")}` : ""}.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="group-label-source">Label on the paper</Label>
        <Input
          id="group-label-source"
          lang={lang}
          className="font-value text-base"
          value={draft.labelSource}
          onChange={(e) => set({ labelSource: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="group-label-meaning">Meaning in English</Label>
        <Input
          id="group-label-meaning"
          placeholder="e.g. Rapid diagnostic test"
          value={draft.labelMeaning}
          onChange={(e) => set({ labelMeaning: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="group-parent">Group</Label>
        <ParentGroupSelect
          id="group-parent"
          tree={tree}
          value={group.parentGroupId}
          onChange={(id) => void moveTo(id)}
          isDisabled={(id) =>
            id !== group.parentGroupId && moveProblem(tree, template.groups, template.fields, { kind: "group", id: group.id }, id) !== null
          }
          disabled={moving}
          lang={lang}
        />
        <p className="text-muted-foreground text-xs">
          Moves it, with everything inside, to the end of the chosen group. Greyed-out choices would refuse it. Or drag it in
          the list.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="group-selection">Selection</Label>
        <Select value={draft.selection} onValueChange={(v) => set({ selection: pickOption(GROUP_SELECTIONS, v) ?? draft.selection })}>
          <SelectTrigger id="group-selection" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUP_SELECTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {GROUP_SELECTION_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{GROUP_SELECTION_HINTS[draft.selection]}</p>
      </div>

      {draft.selection !== "NONE" ? (
        <>
          {draftIssue ? (
            <FormMessage tone={savedIssue ? "info" : "error"}>
              {savedIssue ? draftIssue : `${GROUP_SELECTION_LABELS[draft.selection]} isn't available: ${draftIssue}`}
            </FormMessage>
          ) : null}
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Options ({options.length})</p>
            {options.length === 0 ? (
              <p className="text-muted-foreground">No Mark / tick fields in Extract or Manual mode inside this group yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5" aria-label="Options">
                {options.map((f) => (
                  <li key={f.id} lang={lang} className="font-value bg-muted rounded px-2 py-0.5">
                    {formatPath(headerPath(tree, { kind: "field", id: f.id }).slice(path.length))}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground text-xs">The AI reports each tick as seen; the answer is worked out afterwards.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-none-marked">When nothing is ticked</Label>
              <Select value={draft.noneMarked} onValueChange={(v) => set({ noneMarked: pickOption(NONE_MARKED, v) ?? draft.noneMarked })}>
                <SelectTrigger id="group-none-marked" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NONE_MARKED.map((s) => (
                    <SelectItem key={s} value={s}>
                      {NONE_MARKED_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{NONE_MARKED_HINTS[draft.noneMarked]}</p>
            </div>
            {draft.selection === "ONE_OF" ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="group-multiple-marked">When several are ticked</Label>
                <Select
                  value={draft.multipleMarked}
                  onValueChange={(v) => set({ multipleMarked: pickOption(MULTIPLE_MARKED, v) ?? draft.multipleMarked })}
                >
                  <SelectTrigger id="group-multiple-marked" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MULTIPLE_MARKED.map((s) => (
                      <SelectItem key={s} value={s}>
                        {MULTIPLE_MARKED_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{MULTIPLE_MARKED_HINTS[draft.multipleMarked]}</p>
              </div>
            ) : null}
          </div>
          <p className="text-muted-foreground -mt-2 text-xs">An unreadable tick is always flagged for review, never read as blank.</p>
        </>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="group-note">Note for the AI</Label>
        <Textarea
          id="group-note"
          placeholder="e.g. Result columns of the malaria rapid test."
          value={draft.note}
          onChange={(e) => set({ note: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">An instruction sent with this header and the columns under it.</p>
      </div>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {pending ? "Saving…" : dirty ? "Saves when you move on" : "All changes saved"}
        </p>
        <Button type="button" variant="ghost" className="text-destructive ml-auto" onClick={onDelete} disabled={pending}>
          <Trash2 />
          Delete group
        </Button>
      </div>
    </form>
  );
}
