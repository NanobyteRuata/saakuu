"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { generateKeyBetween } from "fractional-indexing";
import { ChevronDown, ChevronRight, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteJson, patchJson, postJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import type { TemplateDetail } from "@/lib/templates/service";
import type { FieldView, GroupView } from "@/lib/templates/views";
import { cn } from "@/lib/utils";

import { ModeChip, TypeChip } from "./badges";

const UNGROUPED_KEY = "group:ungrouped";
const NO_GROUP = "none";
const groupKey = (id: string) => `group:${id}`;

type Positioned = { id: string; position: string };

/** Fractional keys compare by code unit, not locale. */
function byPosition(a: Positioned, b: Positioned): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Key for an optimistic move, or null when only the server can decide (e.g. equal neighbour keys). */
function localPosition(siblings: Positioned[], afterId: string | null, movingId: string): string | null {
  const list = siblings.filter((s) => s.id !== movingId).sort(byPosition);
  const at = afterId === null ? 0 : list.findIndex((s) => s.id === afterId) + 1;
  if (afterId !== null && at === 0) return null;
  try {
    return generateKeyBetween(list[at - 1]?.position ?? null, list[at]?.position ?? null);
  } catch {
    return null;
  }
}

type Item =
  | { kind: "group"; key: string; group: GroupView | null; count: number }
  | { kind: "field"; key: string; field: FieldView };

type Props = {
  template: TemplateDetail;
  setTemplate: Dispatch<SetStateAction<TemplateDetail>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  reload: () => Promise<void>;
  lang: string | undefined;
};

/**
 * Groups → fields as one flattened sortable list. A dropped field joins the nearest group header
 * above it; dragging a group header collapses the list to headers so it's a pure group reorder.
 * Drag handles also work from the keyboard (Space to lift, arrows to move, Space to drop).
 * Every move writes one row on the server and is applied optimistically.
 */
export function FieldTree({ template, setTemplate, selectedId, onSelect, reload, lang }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [draggingGroup, setDraggingGroup] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newFieldGroup, setNewFieldGroup] = useState(NO_GROUP);
  const [newGroupLabel, setNewGroupLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [groupToDelete, setGroupToDelete] = useState<{ group: GroupView; count: number } | null>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const groups = [...template.groups].sort(byPosition);
  const groupIds = new Set(groups.map((g) => g.id));
  const groupOf = (f: FieldView) => (f.groupId !== null && groupIds.has(f.groupId) ? f.groupId : null);
  const byGroup = new Map<string | null, FieldView[]>();
  for (const f of template.fields) {
    const list = byGroup.get(groupOf(f)) ?? [];
    list.push(f);
    byGroup.set(groupOf(f), list);
  }
  for (const list of byGroup.values()) list.sort(byPosition);

  const items: Item[] = [];
  for (const group of [null, ...groups]) {
    const fields = byGroup.get(group?.id ?? null) ?? [];
    items.push({ kind: "group", key: group ? groupKey(group.id) : UNGROUPED_KEY, group, count: fields.length });
    if (draggingGroup || (group && collapsed.has(group.id))) continue;
    for (const field of fields) items.push({ kind: "field", key: field.id, field });
  }

  function setCollapsedFor(id: string, value: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function onDragStart({ active }: DragStartEvent) {
    if (String(active.id).startsWith("group:")) setDraggingGroup(true);
  }

  async function onDragEnd({ active, over }: DragEndEvent) {
    const wasGroup = draggingGroup;
    setDraggingGroup(false);
    if (!over || active.id === over.id) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    if (wasGroup) {
      await moveGroup(activeKey.slice("group:".length), overKey);
      return;
    }
    const from = items.findIndex((i) => i.key === activeKey);
    const to = items.findIndex((i) => i.key === overKey);
    if (from < 0 || to < 0) return;
    const moved = arrayMove(items, from, to);
    const k = moved.findIndex((i) => i.key === activeKey);
    const prev = moved[k - 1];
    const afterId = prev?.kind === "field" ? prev.field.id : null;
    let groupId: string | null = null;
    for (let j = k - 1; j >= 0; j--) {
      const it = moved[j];
      if (it?.kind === "group") {
        groupId = it.group?.id ?? null;
        break;
      }
    }
    await moveField(activeKey, groupId, afterId);
  }

  async function moveField(fieldId: string, groupId: string | null, afterId: string | null) {
    const field = template.fields.find((f) => f.id === fieldId);
    if (!field) return;
    const current = byGroup.get(groupOf(field)) ?? [];
    const idx = current.findIndex((f) => f.id === fieldId);
    if (groupOf(field) === groupId && (current[idx - 1]?.id ?? null) === afterId) return;

    const original = { groupId: field.groupId, position: field.position };
    const position = localPosition(byGroup.get(groupId) ?? [], afterId, fieldId);
    if (position) {
      setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === fieldId ? { ...f, groupId, position } : f)) }));
    }
    const result = await patchJson<FieldView>(`/api/fields/${fieldId}`, { move: { groupId, afterId } });
    if (!result.ok) {
      setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === fieldId ? { ...f, ...original } : f)) }));
      setError(result.error.message);
      return;
    }
    setError(null);
    setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === fieldId ? result.data : f)) }));
  }

  async function moveGroup(groupId: string, overKey: string) {
    const ids = groups.map((g) => g.id);
    const from = ids.indexOf(groupId);
    const to = overKey === UNGROUPED_KEY ? 0 : ids.indexOf(overKey.slice("group:".length));
    if (from < 0 || to < 0 || from === to) return;
    const order = arrayMove(ids, from, to);
    const k = order.indexOf(groupId);
    const afterId = k > 0 ? (order[k - 1] ?? null) : null;
    const originalPosition = groups[from]?.position ?? "";

    const position = localPosition(groups, afterId, groupId);
    if (position) {
      setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === groupId ? { ...g, position } : g)) }));
    }
    const result = await patchJson<GroupView>(`/api/groups/${groupId}`, { afterId });
    if (!result.ok) {
      setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === groupId ? { ...g, position: originalPosition } : g)) }));
      setError(result.error.message);
      return;
    }
    setError(null);
    setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === groupId ? result.data : g)) }));
  }

  async function addField(e: FormEvent) {
    e.preventDefault();
    const labelSource = newLabel.trim();
    if (!labelSource) {
      setError("Type the field's label as it's written on the paper.");
      return;
    }
    const groupId = newFieldGroup === NO_GROUP || !groupIds.has(newFieldGroup) ? null : newFieldGroup;
    setBusy(true);
    const result = await postJson<FieldView>(`/api/templates/${template.id}/fields`, { labelSource, groupId });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setNewLabel("");
    if (groupId) setCollapsedFor(groupId, false);
    setTemplate((t) => ({ ...t, fields: [...t.fields, result.data] }));
    labelInput.current?.focus();
  }

  async function addGroup(e: FormEvent) {
    e.preventDefault();
    const label = newGroupLabel.trim();
    if (!label) {
      setError("Give the group a name.");
      return;
    }
    setBusy(true);
    const result = await postJson<GroupView>(`/api/templates/${template.id}/groups`, { label });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setNewGroupLabel("");
    setNewFieldGroup(result.data.id);
    setTemplate((t) => ({ ...t, groups: [...t.groups, result.data] }));
  }

  async function renameGroup(groupId: string, label: string): Promise<boolean> {
    const result = await patchJson<GroupView>(`/api/groups/${groupId}`, { label });
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    setError(null);
    setTemplate((t) => ({ ...t, groups: t.groups.map((g) => (g.id === groupId ? result.data : g)) }));
    return true;
  }

  async function confirmDeleteGroup() {
    if (!groupToDelete) return;
    setBusy(true);
    const result = await deleteJson<{ movedFields: number }>(`/api/groups/${groupToDelete.group.id}`);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      setGroupToDelete(null);
      return;
    }
    const { label } = groupToDelete.group;
    setGroupToDelete(null);
    if (newFieldGroup === groupToDelete.group.id) setNewFieldGroup(NO_GROUP);
    await reload();
    toast.success(`Deleted the group “${label}”. ${plural(result.data.movedFields, "field")} moved to Ungrouped.`);
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={addField} className="flex flex-wrap items-center gap-2" noValidate>
        <Input
          ref={labelInput}
          aria-label="New field label, as written on the paper"
          placeholder="Label as written, e.g. အမည်"
          lang={lang}
          className="font-value min-w-48 flex-1"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        {/* Radix can report "" while a just-added group's item mounts; ignore it rather than falling back to Ungrouped. */}
        <Select
          value={groupIds.has(newFieldGroup) ? newFieldGroup : NO_GROUP}
          onValueChange={(v) => v && setNewFieldGroup(v)}
        >
          <SelectTrigger aria-label="Group for the new field" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUP}>Ungrouped</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" disabled={busy}>
          <Plus />
          Add field
        </Button>
      </form>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <DndContext id="template-fields" sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDraggingGroup(false)}>
        <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-1.5" aria-label="Fields by group">
            {items.map((item) =>
              item.kind === "group" ? (
                <GroupHeader
                  key={item.key}
                  sortId={item.key}
                  group={item.group}
                  count={item.count}
                  collapsed={item.group !== null && (draggingGroup || collapsed.has(item.group.id))}
                  onToggle={(value) => item.group && setCollapsedFor(item.group.id, value)}
                  onRename={(label) => (item.group ? renameGroup(item.group.id, label) : Promise.resolve(false))}
                  onDelete={() => item.group && setGroupToDelete({ group: item.group, count: item.count })}
                  empty={template.fields.length === 0 && item.group === null}
                />
              ) : (
                <FieldRow
                  key={item.key}
                  field={item.field}
                  isSequence={template.sequenceFieldId === item.field.id}
                  selected={selectedId === item.field.id}
                  lang={lang}
                  onSelect={() => onSelect(item.field.id)}
                />
              ),
            )}
          </ol>
        </SortableContext>
      </DndContext>

      <form onSubmit={addGroup} className="flex flex-wrap items-center gap-2 border-t pt-4" noValidate>
        <Input
          aria-label="New group name"
          placeholder="Group name, e.g. Child details"
          className="min-w-48 flex-1"
          value={newGroupLabel}
          onChange={(e) => setNewGroupLabel(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy}>
          <Plus />
          Add group
        </Button>
      </form>

      <AlertDialog open={groupToDelete !== null} onOpenChange={(open) => !open && !busy && setGroupToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the group “{groupToDelete?.group.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(groupToDelete?.count ?? 0, "field")} in this group{" "}
              {groupToDelete?.count === 1 ? "moves" : "move"} to Ungrouped. No fields or values are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy}>
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" onClick={confirmDeleteGroup} disabled={busy}>
              Delete group
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type GroupHeaderProps = {
  sortId: string;
  group: GroupView | null;
  count: number;
  collapsed: boolean;
  empty: boolean;
  onToggle: (collapsed: boolean) => void;
  onRename: (label: string) => Promise<boolean>;
  onDelete: () => void;
};

function GroupHeader({ sortId, group, count, collapsed, empty, onToggle, onRename, onDelete }: GroupHeaderProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: sortId,
    // "Ungrouped" is fixed at the top but fields can still be dropped under it.
    disabled: group ? false : { draggable: true, droppable: false },
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const name = group?.label ?? "Ungrouped";

  async function save() {
    const label = draft.trim();
    if (!label || label === group?.label) {
      setEditing(false);
      return;
    }
    if (await onRename(label)) setEditing(false);
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex flex-col pt-2 first:pt-0", isDragging && "relative z-10")}
    >
      <div className={cn("flex items-center gap-2 rounded-md px-1 py-1", isDragging && "bg-card shadow-md")}>
        {group ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Drag to reorder group ${name}`}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 cursor-grab touch-none rounded outline-none focus-visible:ring-[3px]"
          >
            <GripVertical className="size-4" />
          </button>
        ) : (
          <span className="w-4" aria-hidden />
        )}
        {group ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
            onClick={() => onToggle(!collapsed)}
            className="text-muted-foreground hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
        ) : null}
        {editing ? (
          <Input
            autoFocus
            aria-label={`Rename group ${name}`}
            className="h-8 flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            onBlur={() => void save()}
          />
        ) : (
          <h3 className={cn("text-sm font-semibold", !group && "text-muted-foreground")}>{name}</h3>
        )}
        <span className="text-muted-foreground text-xs">{plural(count, "field")}</span>
        {group && !editing ? (
          <div className="ml-auto flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Rename group ${name}`}
              onClick={() => {
                setDraft(group.label);
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Delete group ${name}`} onClick={onDelete}>
              <Trash2 />
            </Button>
          </div>
        ) : null}
      </div>
      {empty ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
          No fields yet. Add one field for each thing you want read from the paper, using its label exactly as it&apos;s
          written. Groups are optional and only help you organise.
        </p>
      ) : null}
    </li>
  );
}

type FieldRowProps = {
  field: FieldView;
  isSequence: boolean;
  selected: boolean;
  lang: string | undefined;
  onSelect: () => void;
};

function FieldRow({ field, isSequence, selected, lang, onSelect }: FieldRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-card ml-6 flex items-center gap-2 rounded-md border px-2 py-1.5",
        selected && "border-foreground ring-foreground/15 ring-2",
        field.mode === "SKIP" && "bg-muted/40",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${field.labelSource}`}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 cursor-grab touch-none rounded outline-none focus-visible:ring-[3px]"
      >
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
    </li>
  );
}
