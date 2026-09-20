"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { patchJson, postJson } from "@/lib/api-client";
import { pickOption } from "@/lib/books/labels";
import { plural } from "@/lib/format";
import { FIELD_GUIDANCE, FIELD_TYPE_LABELS, GROUP_SELECTION_LABELS } from "@/lib/templates/labels";
import { FIELD_TYPES } from "@/lib/templates/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import {
  childrenOf,
  descendants,
  findNode,
  flattenTree,
  groupPlacementProblem,
  localPositionAfter,
  moveProblem,
  nearestGroupParent,
  nearestSelectionGroup,
  sameRef,
  selectionProblem,
  toSibling,
  type FieldNode,
  type GroupNode,
  type SiblingRef,
  type Tree,
  type TreeNode,
} from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";
import { cn } from "@/lib/utils";

import { ModeChip, TypeChip } from "./badges";
import { ParentGroupSelect } from "./parent-group-select";

type SourceTree = Tree<GroupView, FieldView>;
type Node = TreeNode<GroupView, FieldView>;
type AddKind = "field" | "group";

const INDENT = 24;
const AUTO = "auto";
/**
 * Rows scrolled into view stop below the pinned add bar. Offsets are measured from the scroll
 * container, which is the workspace's own scroll area rather than the page (docs/05 §0).
 */
const ROW_SCROLL_MARGIN = "scroll-mt-28";

const keyOf = (ref: SiblingRef) => `${ref.kind}:${ref.id}`;

function refOf(key: string): SiblingRef | null {
  const [kind, id] = key.split(":");
  return (kind === "field" || kind === "group") && id ? { kind, id } : null;
}

/** ←/→ shift the drag one indent (out of / into a group); ↑/↓ move between rows and keep that shift. */
const treeKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const { currentCoordinates } = args;
  if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
    event.preventDefault();
    return { x: currentCoordinates.x + (event.code === "ArrowRight" ? INDENT : -INDENT), y: currentCoordinates.y };
  }
  const next = sortableKeyboardCoordinates(event, args);
  return next ? { x: currentCoordinates.x, y: next.y } : next;
};

const SCREEN_READER_INSTRUCTIONS =
  "To move an item, press Space to pick it up. Use the up and down arrow keys to move it, the right arrow key to put it inside the group above, and the left arrow key to move it out of its group. Press Space again to drop it, or Escape to cancel.";

/** dnd-kit's default announcements read internal ids; the tree speaks through its own live region instead. */
const SILENT_ANNOUNCEMENTS: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

type Projection = { depth: number; parentId: string | null; after: SiblingRef | null };

/**
 * Where the dragged row would land (dnd-kit's sortable tree pattern): the row it's over sets the
 * vertical slot, the horizontal drag sets the depth, bounded by the rows above and below.
 */
function project(items: Node[], activeKey: string, overKey: string, offset: number): Projection | null {
  const activeIndex = items.findIndex((n) => keyOf(n) === activeKey);
  const overIndex = items.findIndex((n) => keyOf(n) === overKey);
  const active = items[activeIndex];
  if (!active || overIndex < 0) return null;
  const moved = arrayMove(items, activeIndex, overIndex);
  const prev = moved[overIndex - 1];
  const next = moved[overIndex + 1];
  const maxDepth = prev ? (prev.kind === "group" ? prev.depth + 1 : prev.depth) : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.max(minDepth, Math.min(maxDepth, active.depth + Math.round(offset / INDENT)));
  for (let i = overIndex - 1; i >= 0; i--) {
    const item = moved[i];
    if (!item) break;
    if (item.depth === depth) return { depth, parentId: item.parentId, after: { kind: item.kind, id: item.id } };
    if (item.depth < depth) return { depth, parentId: item.kind === "group" ? item.id : item.parentId, after: null };
  }
  return { depth, parentId: null, after: null };
}

function isNoop(tree: SourceTree, ref: SiblingRef, p: Projection): boolean {
  const node = findNode(tree, ref);
  if (!node || node.parentId !== p.parentId) return false;
  const siblings = childrenOf(tree, p.parentId);
  const prev = siblings[siblings.indexOf(node) - 1];
  return prev ? sameRef(prev, p.after) : p.after === null;
}

function nodeLabel(tree: SourceTree, ref: SiblingRef): string {
  const node = findNode(tree, ref);
  if (!node) return "the item";
  return node.kind === "group" ? node.group.labelSource : node.field.labelSource;
}

/** "inside RDT Test, after Positive" or "at the top level, first", for spoken drag updates. */
function placeText(tree: SourceTree, parentId: string | null, after: SiblingRef | null): string {
  const parent = parentId === null ? undefined : tree.groups.get(parentId);
  const where = parent ? `inside ${parent.group.labelSource}` : "at the top level";
  return `${where}, ${after ? `after ${nodeLabel(tree, after)}` : "first"}`;
}

function currentPlace(tree: SourceTree, ref: SiblingRef): string {
  const node = findNode(tree, ref);
  if (!node) return "";
  const siblings = childrenOf(tree, node.parentId);
  const prev = siblings[siblings.indexOf(node) - 1];
  return placeText(tree, node.parentId, prev ? { kind: prev.kind, id: prev.id } : null);
}

type Props = {
  template: TemplateDetail;
  tree: SourceTree;
  setTemplate: Dispatch<SetStateAction<TemplateDetail>>;
  selected: SiblingRef | null;
  onSelect: (ref: SiblingRef) => void;
  onDeleteGroup: (group: GroupView) => void;
  reload: () => Promise<void>;
  lang: string | undefined;
};

/**
 * The source layer in paper order: groups and fields interleave at every level and groups nest
 * (docs/05, Phase 3.1). Drag vertically to reorder, right to nest into the group above, left to
 * move out. Drag handles also work from the keyboard: Space to lift, ↑/↓ to move, →/← to nest or
 * un-nest, Space to drop, with each step spoken by label. Every move writes one row on the server
 * and is applied optimistically.
 *
 * Adding: one add bar pinned above the list, whose parent follows the selection, and a "+" on each
 * group that opens an inline row at the end of that group.
 */
export function FieldTree({ template, tree, setTemplate, selected, onSelect, onDeleteGroup, reload, lang }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [addKind, setAddKind] = useState<AddKind>("field");
  const [newLabel, setNewLabel] = useState("");
  const [newParent, setNewParent] = useState<string | null>(null);
  const [newType, setNewType] = useState<string>(AUTO);
  const [inlineGroupId, setInlineGroupId] = useState<string | null>(null);
  const [scrollKey, setScrollKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labelInput = useRef<HTMLInputElement>(null);
  const lastProjectionMessage = useRef<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: treeKeyboardCoordinates }),
  );

  // The add bar follows the selection once it actually changes; an unsaved-changes prompt can stop a selection.
  const selectedKey = selected ? keyOf(selected) : null;
  const [followedKey, setFollowedKey] = useState(selectedKey);
  if (selectedKey !== followedKey) {
    setFollowedKey(selectedKey);
    const node = selected ? findNode(tree, selected) : undefined;
    if (node) {
      setNewParent(node.kind === "group" ? node.id : node.parentId);
      setNewType(AUTO);
    }
  }

  const activeRef = activeKey ? refOf(activeKey) : null;
  // A dragged group carries its contents with it, so they're hidden while it moves.
  const hidden = new Set(collapsed);
  if (activeRef?.kind === "group") hidden.add(activeRef.id);
  const items = flattenTree(tree, hidden);
  const projection = activeKey && overKey ? project(items, activeKey, overKey, offset) : null;
  const moving = activeRef && projection && !isNoop(tree, activeRef, projection);
  const dropProblem = activeRef && projection && moving ? moveProblem(tree, template.groups, template.fields, activeRef, projection.parentId) : null;
  const projectionMessage =
    activeRef && projection
      ? dropProblem
        ? `Can't go here: ${dropProblem}`
        : moving
          ? `${nodeLabel(tree, activeRef)} would go ${placeText(tree, projection.parentId, projection.after)}.`
          : `${nodeLabel(tree, activeRef)} is back where it was.`
      : null;
  const parentId = newParent !== null && tree.groups.has(newParent) ? newParent : null;
  // A new group can't go below level 3; fall back to the nearest parent that can take one.
  const barParent = addKind === "group" ? nearestGroupParent(tree, parentId) : parentId;
  const inlineGroup = inlineGroupId !== null && activeKey === null ? tree.groups.get(inlineGroupId) : undefined;

  // Bring a just-added row into view.
  useEffect(() => {
    if (scrollKey === null) return;
    document.querySelector(`[data-node="${scrollKey}"]`)?.scrollIntoView({ block: "nearest" });
    setScrollKey(null);
  }, [scrollKey]);

  // Speak where the dragged row would land whenever that changes (pick-up has its own message).
  useEffect(() => {
    if (projectionMessage === null) {
      lastProjectionMessage.current = null;
      return;
    }
    if (lastProjectionMessage.current !== null && projectionMessage !== lastProjectionMessage.current) {
      setAnnouncement(projectionMessage);
    }
    lastProjectionMessage.current = projectionMessage;
  }, [projectionMessage]);

  function expand(ids: (string | null)[]) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (id !== null) next.delete(id);
      return next;
    });
  }

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function resetDrag() {
    setActiveKey(null);
    setOverKey(null);
    setOffset(0);
  }

  function onDragStart({ active }: DragStartEvent) {
    const key = String(active.id);
    setActiveKey(key);
    setOverKey(key);
    setOffset(0);
    setError(null);
    const ref = refOf(key);
    if (ref) {
      setAnnouncement(
        `Picked up ${nodeLabel(tree, ref)}, ${currentPlace(tree, ref)}. Arrow keys move it; right and left nest and un-nest; Space drops; Escape cancels.`,
      );
    }
  }

  function onDragMove({ delta }: DragMoveEvent) {
    setOffset(delta.x);
  }

  function onDragOver({ over }: DragOverEvent) {
    setOverKey(over ? String(over.id) : null);
  }

  function onDragCancel({ active }: DragCancelEvent) {
    resetDrag();
    const ref = refOf(String(active.id));
    if (ref) setAnnouncement(`${nodeLabel(tree, ref)} stays where it was.`);
  }

  async function onDragEnd({ active, over, delta }: DragEndEvent) {
    const key = String(active.id);
    resetDrag();
    const ref = refOf(key);
    if (!ref) return;
    const label = nodeLabel(tree, ref);
    const p = over ? project(items, key, String(over.id), delta.x) : null;
    if (!p || isNoop(tree, ref, p)) {
      setAnnouncement(`${label} stays where it was.`);
      return;
    }
    const problem = moveProblem(tree, template.groups, template.fields, ref, p.parentId);
    if (problem) {
      setError(problem);
      setAnnouncement(`${label} can't go there, so it stays where it was. ${problem}`);
      return;
    }
    await move(ref, p.parentId, p.after);
  }

  async function move(ref: SiblingRef, parentId: string | null, after: SiblingRef | null) {
    const position = localPositionAfter(childrenOf(tree, parentId).map(toSibling), after, ref);
    const label = nodeLabel(tree, ref);
    const place = placeText(tree, parentId, after);
    expand([parentId]);
    let result: { ok: true } | { ok: false; error: { message: string } };
    if (ref.kind === "field") {
      const original = template.fields.find((f) => f.id === ref.id);
      if (!original) return;
      if (position) {
        setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === ref.id ? { ...f, groupId: parentId, position } : f)) }));
      }
      const saved = await patchJson<FieldView>(`/api/fields/${ref.id}`, { move: { groupId: parentId, after } });
      setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === ref.id ? (saved.ok ? saved.data : original) : f)) }));
      result = saved;
    } else {
      const original = template.groups.find((g) => g.id === ref.id);
      if (!original) return;
      if (position) {
        setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === ref.id ? { ...g, parentGroupId: parentId, position } : g)) }));
      }
      const saved = await patchJson<GroupView>(`/api/groups/${ref.id}`, { move: { parentGroupId: parentId, after } });
      setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === ref.id ? (saved.ok ? saved.data : original) : g)) }));
      result = saved;
    }
    setError(result.ok ? null : result.error.message);
    setAnnouncement(result.ok ? `Moved ${label} ${place}.` : `Couldn't move ${label}. ${result.error.message}`);
    if (result.ok && !position) await reload();
  }

  /** Creates a field at the end of `groupId`. Returns a plain-language problem, or null on success. */
  async function createField(labelSource: string, groupId: string | null, type: string): Promise<string | null> {
    if (!labelSource) return "Type the field's label as it's written on the paper.";
    const dataType = pickOption(FIELD_TYPES, type);
    const result = await postJson<FieldView>(`/api/templates/${template.id}/fields`, {
      labelSource,
      groupId,
      ...(dataType ? { dataType } : {}),
    });
    if (!result.ok) return result.error.message;
    expand([groupId]);
    setTemplate((t) => ({ ...t, fields: [...t.fields, result.data] }));
    setScrollKey(keyOf({ kind: "field", id: result.data.id }));
    return null;
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const labelSource = newLabel.trim();
    setBusy(true);
    if (addKind === "field") {
      const problem = await createField(labelSource, parentId, newType);
      setBusy(false);
      setError(problem);
      if (!problem) setNewLabel("");
      labelInput.current?.focus();
      return;
    }
    if (!labelSource) {
      setBusy(false);
      setError("Type the header as it's written on the paper.");
      return;
    }
    const result = await postJson<GroupView>(`/api/templates/${template.id}/groups`, { labelSource, parentGroupId: barParent });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setNewLabel("");
    expand([barParent]);
    setTemplate((t) => ({ ...t, groups: [...t.groups, result.data] }));
    setScrollKey(keyOf({ kind: "group", id: result.data.id }));
    // Next, add the columns under the header just created.
    setAddKind("field");
    setNewParent(result.data.id);
    setNewType(AUTO);
    labelInput.current?.focus();
  }

  function openInline(groupId: string) {
    expand([groupId]);
    setInlineGroupId(groupId);
    setError(null);
  }

  function inlineRow(group: GroupNode<GroupView, FieldView>) {
    return (
      <InlineAddRow
        key={`inline:${group.id}`}
        group={group}
        tree={tree}
        lang={lang}
        onCreate={(label, type) => createField(label, group.id, type)}
        onClose={() => setInlineGroupId(null)}
      />
    );
  }

  const rows: ReactNode[] = [];
  const inlineAt = inlineGroup ? inlineInsertIndex(items, inlineGroup) : -1;
  items.forEach((node, i) => {
    if (i === inlineAt && inlineGroup) rows.push(inlineRow(inlineGroup));
    const key = keyOf(node);
    const dragging = key === activeKey;
    const depth = dragging && projection ? projection.depth : node.depth;
    rows.push(
      node.kind === "group" ? (
        <GroupRow
          key={key}
          sortId={key}
          node={node}
          depth={depth}
          invalid={dragging && dropProblem !== null}
          collapsed={hidden.has(node.id)}
          selected={sameRef(selected, node)}
          warning={selectionProblem(tree, node.id)}
          lang={lang}
          onToggle={() => toggle(node.id)}
          onSelect={() => onSelect({ kind: "group", id: node.id })}
          onAdd={() => openInline(node.id)}
          onDelete={() => onDeleteGroup(node.group)}
        />
      ) : (
        <FieldRow
          key={key}
          sortId={key}
          node={node}
          depth={depth}
          invalid={dragging && dropProblem !== null}
          isSequence={template.sequenceFieldId === node.id}
          selected={sameRef(selected, node)}
          lang={lang}
          onSelect={() => onSelect({ kind: "field", id: node.id })}
        />
      ),
    );
  });
  if (inlineAt === items.length && inlineGroup) rows.push(inlineRow(inlineGroup));

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="bg-background sticky top-0 z-20 -mx-1 flex flex-col gap-2 border-b px-1 py-2">
        <form onSubmit={add} className="flex flex-col gap-2" noValidate>
          <div className="flex items-center gap-2">
            <div role="radiogroup" aria-label="What to add" className="flex shrink-0 rounded-md border p-0.5">
              {(["field", "group"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={addKind === kind}
                  onClick={() => {
                    setAddKind(kind);
                    setError(null);
                  }}
                  className={cn(
                    "rounded px-2.5 py-1 text-sm font-medium",
                    addKind === kind ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {kind === "field" ? "Field" : "Group"}
                </button>
              ))}
            </div>
            <Input
              ref={labelInput}
              aria-label={addKind === "field" ? "New field label, as written on the paper" : "New group header, as written on the paper"}
              placeholder={addKind === "field" ? "Label as written, e.g. အမည်" : "Header as written, e.g. RDT Test"}
              lang={lang}
              className="font-value min-w-0 flex-1"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <ParentGroupSelect
              ariaLabel={addKind === "field" ? "Group for the new field" : "Parent for the new group"}
              className="min-w-0 flex-1"
              tree={tree}
              value={barParent}
              onChange={(id) => {
                setNewParent(id);
                setNewType(AUTO);
              }}
              isDisabled={addKind === "group" ? (id) => groupPlacementProblem(tree, null, id) !== null : undefined}
              lang={lang}
            />
            {addKind === "field" ? (
              <FieldTypeSelect
                ariaLabel="Type for the new field"
                className="min-w-0 flex-1"
                value={newType}
                autoType={nearestSelectionGroup(tree, parentId) ? "MARK" : "TEXT"}
                onChange={setNewType}
              />
            ) : null}
            <Button type="submit" variant="outline" className="shrink-0" disabled={busy}>
              <Plus />
              {addKind === "field" ? "Add field" : "Add group"}
            </Button>
          </div>
        </form>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
          No fields yet. Add one field for each column or answer box on the paper, using its label exactly as it&apos;s
          written. {FIELD_GUIDANCE[template.kind]} Add groups for the headers above them.
        </p>
      ) : (
        <DndContext
          id="template-fields"
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements: SILENT_ANNOUNCEMENTS, screenReaderInstructions: { draggable: SCREEN_READER_INSTRUCTIONS } }}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={items.map(keyOf)} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col" aria-label="Fields and groups in paper order">
              {rows}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {activeKey && dropProblem ? <FormMessage tone="error">Can&apos;t go here: {dropProblem}</FormMessage> : null}

      {items.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Drag up or down to reorder, right to put an item inside the group above it, left to move it out. With the keyboard,
          focus a handle and press Space, then ↑/↓ to move, →/← to nest or un-nest, and Space to drop. Use + on a group to add
          fields at its end.
        </p>
      ) : null}
    </div>
  );
}

/** The inline add row goes after the group's last visible descendant. */
function inlineInsertIndex(items: Node[], group: GroupNode<GroupView, FieldView>): number {
  const start = items.findIndex((n) => n.kind === "group" && n.id === group.id);
  if (start < 0) return -1;
  let end = start + 1;
  while (end < items.length && (items[end]?.depth ?? 0) > group.depth) end++;
  return end;
}

/** Vertical guide lines, one per group above the row, so a group's contents read as one block. */
function GuideLines({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} aria-hidden className="bg-border absolute inset-y-0 w-px" style={{ left: level * INDENT + 12 }} />
      ))}
    </>
  );
}

function FieldTypeSelect({
  value,
  autoType,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  autoType: "MARK" | "TEXT";
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO}>{FIELD_TYPE_LABELS[autoType]}</SelectItem>
        {/* Choice needs its choices, which only the properties panel can collect: set it there. */}
        {FIELD_TYPES.filter((t) => t !== autoType && t !== "CHOICE").map((t) => (
          <SelectItem key={t} value={t}>
            {FIELD_TYPE_LABELS[t]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type InlineAddRowProps = {
  group: GroupNode<GroupView, FieldView>;
  tree: SourceTree;
  lang: string | undefined;
  onCreate: (label: string, type: string) => Promise<string | null>;
  onClose: () => void;
};

/** Adds fields one after another at the end of a group: type, Enter, type, Enter. Escape closes. */
function InlineAddRow({ group, tree, lang, onCreate, onClose }: InlineAddRowProps) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<string>(AUTO);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const depth = group.depth + 1;

  useEffect(() => {
    input.current?.focus();
    input.current?.scrollIntoView({ block: "nearest" });
  }, [group.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await onCreate(label.trim(), type);
    setBusy(false);
    setProblem(result);
    if (!result) setLabel("");
    input.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <li className={cn("relative pb-1", ROW_SCROLL_MARGIN)} style={{ paddingLeft: depth * INDENT }}>
      <GuideLines depth={depth} />
      <form
        onSubmit={submit}
        onKeyDown={onKeyDown}
        noValidate
        aria-label={`Add fields to ${group.group.labelSource}`}
        className="flex flex-col gap-1 rounded-md border border-dashed px-2 py-1.5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={input}
            aria-label={`New field in ${group.group.labelSource}, as written on the paper`}
            placeholder="Label as written, then Enter"
            lang={lang}
            className="font-value h-8 min-w-32 flex-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <FieldTypeSelect
            ariaLabel={`Type for the new field in ${group.group.labelSource}`}
            className="h-8 w-36"
            value={type}
            autoType={nearestSelectionGroup(tree, group.id) ? "MARK" : "TEXT"}
            onChange={setType}
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            <Plus />
            Add
          </Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Stop adding to this group" onClick={onClose}>
            <X />
          </Button>
        </div>
        {problem ? (
          <p role="alert" className="text-destructive text-xs">
            {problem}
          </p>
        ) : null}
      </form>
    </li>
  );
}

const handleClass =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 cursor-grab touch-none rounded outline-none focus-visible:ring-[3px]";

type GroupRowProps = {
  sortId: string;
  node: GroupNode<GroupView, FieldView>;
  depth: number;
  invalid: boolean;
  collapsed: boolean;
  selected: boolean;
  warning: string | null;
  lang: string | undefined;
  onToggle: () => void;
  onSelect: () => void;
  onAdd: () => void;
  onDelete: () => void;
};

function GroupRow({ sortId, node, depth, invalid, collapsed, selected, warning, lang, onToggle, onSelect, onAdd, onDelete }: GroupRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: sortId });
  const { group } = node;
  const fieldCount = descendants(node).filter((n) => n.kind === "field").length;
  return (
    <li
      ref={setNodeRef}
      data-node={sortId}
      style={{ transform: CSS.Translate.toString(transform), transition, paddingLeft: depth * INDENT }}
      className={cn("relative flex pb-1", ROW_SCROLL_MARGIN, isDragging && "z-10")}
    >
      <GuideLines depth={depth} />
      <div
        className={cn(
          "bg-muted/60 flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5",
          selected && "border-foreground ring-foreground/15 ring-2",
          isDragging && "bg-card shadow-md",
          invalid && "border-destructive",
        )}
      >
        <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Drag to move group ${group.labelSource}`} className={handleClass}>
          <GripVertical className="size-4" />
        </button>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.labelSource}`}
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
          <span lang={lang} className="font-value truncate font-semibold">
            {group.labelSource}
          </span>
          {group.labelMeaning ? <span className="text-muted-foreground truncate text-xs">{group.labelMeaning}</span> : null}
        </button>
        {warning ? (
          <span role="img" title={warning} aria-label={warning} className="text-amber-600">
            <TriangleAlert className="size-4" />
          </span>
        ) : null}
        {group.selection !== "NONE" ? <Badge variant="outline">{GROUP_SELECTION_LABELS[group.selection]}</Badge> : null}
        <span className="text-muted-foreground text-xs whitespace-nowrap">{plural(fieldCount, "field")}</span>
        <div className="flex">
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Add a field to ${group.labelSource}`} onClick={onAdd}>
            <Plus />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Delete group ${group.labelSource}`} onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>
    </li>
  );
}

type FieldRowProps = {
  sortId: string;
  node: FieldNode<FieldView>;
  depth: number;
  invalid: boolean;
  isSequence: boolean;
  selected: boolean;
  lang: string | undefined;
  onSelect: () => void;
};

function FieldRow({ sortId, node, depth, invalid, isSequence, selected, lang, onSelect }: FieldRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: sortId });
  const { field } = node;
  return (
    <li
      ref={setNodeRef}
      data-node={sortId}
      style={{ transform: CSS.Translate.toString(transform), transition, paddingLeft: depth * INDENT }}
      className={cn("relative flex pb-1", ROW_SCROLL_MARGIN, isDragging && "z-10")}
    >
      <GuideLines depth={depth} />
      <div
        className={cn(
          "bg-card flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5",
          selected && "border-foreground ring-foreground/15 ring-2",
          field.mode === "SKIP" && "bg-muted/40",
          isDragging && "shadow-md",
          invalid && "border-destructive",
        )}
      >
        <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Drag to move ${field.labelSource}`} className={handleClass}>
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className="min-w-0 flex-1 text-left">
          <span lang={lang} className="font-value block truncate font-medium">
            {field.labelSource}
          </span>
          {field.labelMeaning ? <span className="text-muted-foreground block truncate text-xs">{field.labelMeaning}</span> : null}
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {isSequence ? <Badge variant="outline">Sequence</Badge> : null}
          <TypeChip type={field.dataType} />
          <ModeChip mode={field.mode} />
        </div>
      </div>
    </li>
  );
}
