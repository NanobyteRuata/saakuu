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
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { patchJson, postJson } from "@/lib/api-client";
import { pickOption } from "@/lib/books/labels";
import { plural } from "@/lib/format";
import { duplicateNames, localPositionAfter } from "@/lib/templates/field-list";
import { FIELD_GUIDANCE, FIELD_TYPE_LABELS } from "@/lib/templates/labels";
import { FIELD_TYPES } from "@/lib/templates/schemas";
import type { TemplateDetail } from "@/lib/templates/service";
import type { FieldView } from "@/lib/templates/views";
import { cn } from "@/lib/utils";

import { ModeChip, TypeChip } from "./badges";
import { FieldName } from "./field-name";

const AUTO = "auto";
/**
 * Rows scrolled into view stop below the pinned add bar. Offsets are measured from the scroll
 * container, which is the workspace's own scroll area rather than the page (docs/05 §0).
 */
const ROW_SCROLL_MARGIN = "scroll-mt-28";

const SCREEN_READER_INSTRUCTIONS =
  "To move a field, press Space to pick it up. Use the up and down arrow keys to move it. Press Space again to drop it, or Escape to cancel.";

/** dnd-kit's default announcements read internal ids; the list speaks through its own live region instead. */
const SILENT_ANNOUNCEMENTS: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/** Shown on both fields that share a name, and in the properties of either. */
export function duplicateNameWarning(name: string): string {
  return `Another field is also named “${name}”. Put the header in front, like “Day 1 › ${name}”, so you can tell them apart.`;
}

/** The field a dragged one lands after (null = first), or undefined when it would not move. */
function dropAfter(list: FieldView[], activeId: string, overId: string): string | null | undefined {
  const from = list.findIndex((f) => f.id === activeId);
  const to = list.findIndex((f) => f.id === overId);
  if (from < 0 || to < 0 || from === to) return undefined;
  return arrayMove(list, from, to)[to - 1]?.id ?? null;
}

function placeText(list: FieldView[], after: string | null): string {
  const field = after === null ? undefined : list.find((f) => f.id === after);
  return field ? `after ${field.labelSource}` : "first";
}

type Props = {
  template: TemplateDetail;
  /** The template's fields in paper order. */
  list: FieldView[];
  setTemplate: Dispatch<SetStateAction<TemplateDetail>>;
  selectedId: string | null;
  onSelect: (fieldId: string) => void;
  reload: () => Promise<void>;
  lang: string | undefined;
  /**
   * Phase 15: below three panes the selected row's properties open underneath it, rather than in a
   * permanent narrow column. Returning null leaves the row as it is.
   */
  renderDetail?: (fieldId: string) => ReactNode;
};

/**
 * The source layer in paper order (docs/05, decision 84): one flat list of fields, each one box on
 * the paper. A header above a field is the front of its name. Drag to reorder; the handles also work
 * from the keyboard (Space to lift, ↑/↓ to move, Space to drop), with each step spoken by name.
 * Every move writes one row on the server and is applied optimistically.
 *
 * Two fields with the same name are marked, never refused.
 */
export function FieldList({ template, list, setTemplate, selectedId, onSelect, reload, lang, renderDetail }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<string>(AUTO);
  const [scrollId, setScrollId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const duplicates = duplicateNames(list);
  const after = activeId && overId ? dropAfter(list, activeId, overId) : undefined;

  // Bring a just-added row into view.
  useEffect(() => {
    if (scrollId === null) return;
    document.querySelector(`[data-node="field:${scrollId}"]`)?.scrollIntoView({ block: "nearest" });
    setScrollId(null);
  }, [scrollId]);

  // Speak where the dragged row would land whenever that changes.
  const active = activeId ? list.find((f) => f.id === activeId) : undefined;
  const dropMessage = active
    ? after !== undefined
      ? `${active.labelSource} would go ${placeText(list, after)}.`
      : `${active.labelSource} is back where it was.`
    : null;
  const lastDropMessage = useRef<string | null>(null);
  useEffect(() => {
    if (dropMessage !== null && lastDropMessage.current !== null && dropMessage !== lastDropMessage.current) setAnnouncement(dropMessage);
    lastDropMessage.current = dropMessage;
  }, [dropMessage]);

  const replaceField = (field: FieldView) => setTemplate((t) => ({ ...t, fields: t.fields.map((f) => (f.id === field.id ? field : f)) }));

  function resetDrag() {
    setActiveId(null);
    setOverId(null);
  }

  function onDragStart({ active }: DragStartEvent) {
    const id = String(active.id);
    setActiveId(id);
    setOverId(id);
    setError(null);
    const field = list.find((f) => f.id === id);
    if (field) setAnnouncement(`Picked up ${field.labelSource}. Arrow keys move it; Space drops; Escape cancels.`);
  }

  function onDragOver({ over }: DragOverEvent) {
    setOverId(over ? String(over.id) : null);
  }

  function onDragCancel({ active }: DragCancelEvent) {
    resetDrag();
    const field = list.find((f) => f.id === String(active.id));
    if (field) setAnnouncement(`${field.labelSource} stays where it was.`);
  }

  async function onDragEnd({ active, over }: DragEndEvent) {
    const id = String(active.id);
    resetDrag();
    const original = list.find((f) => f.id === id);
    if (!original) return;
    const to = over ? dropAfter(list, id, String(over.id)) : undefined;
    if (to === undefined) {
      setAnnouncement(`${original.labelSource} stays where it was.`);
      return;
    }
    const place = placeText(list, to);
    const position = localPositionAfter(list, to, id);
    if (position) replaceField({ ...original, position });
    const saved = await patchJson<FieldView>(`/api/fields/${id}`, { move: { after: to } });
    replaceField(saved.ok ? saved.data : original);
    setError(saved.ok ? null : saved.error.message);
    setAnnouncement(saved.ok ? `Moved ${original.labelSource} ${place}.` : `Couldn't move ${original.labelSource}. ${saved.error.message}`);
    if (saved.ok && !position) await reload();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const labelSource = newName.trim();
    if (!labelSource) {
      setError("Type the field's name as it's written on the paper.");
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    const dataType = pickOption(FIELD_TYPES, newType);
    const result = await postJson<FieldView>(`/api/templates/${template.id}/fields`, { labelSource, ...(dataType ? { dataType } : {}) });
    setBusy(false);
    setError(result.ok ? null : result.error.message);
    if (result.ok) {
      setTemplate((t) => ({ ...t, fields: [...t.fields, result.data] }));
      setScrollId(result.data.id);
      setNewName("");
    }
    nameInput.current?.focus();
  }

  const rows: ReactNode[] = [];
  for (const field of list) {
    rows.push(
      <FieldRow
        key={`field:${field.id}`}
        field={field}
        isSequence={template.sequenceFieldId === field.id}
        selected={selectedId === field.id}
        duplicate={duplicates.has(field.id)}
        lang={lang}
        onSelect={() => onSelect(field.id)}
      />,
    );
    /*
     * The properties sit under the row they belong to, outside the sortable list: a detail panel
     * that took part in the drag would be treated as another item to reorder.
     */
    const detail = renderDetail?.(field.id);
    if (detail) {
      rows.push(
        <li key={`field:${field.id}-detail`} className="pb-2 pl-6">
          <section aria-label="Properties" className="bg-card rounded-lg border p-3">
            {detail}
          </section>
        </li>,
      );
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="bg-background sticky top-0 z-20 -mx-1 flex flex-col gap-2 border-b px-1 py-2">
        <form onSubmit={add} className="flex flex-wrap items-center gap-2" noValidate>
          <Input
            ref={nameInput}
            aria-label="New field name, as written on the paper"
            placeholder="Name as written, e.g. အမည်"
            lang={lang}
            className="font-value min-w-40 flex-1"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <FieldTypeSelect ariaLabel="Type for the new field" className="w-36" value={newType} onChange={setNewType} />
          <Button type="submit" variant="outline" className="shrink-0" disabled={busy}>
            <Plus />
            Add field
          </Button>
        </form>
        <p className="text-muted-foreground text-xs">
          Adds at the end of the list. If a header is printed above it, put the header in front, like{" "}
          <span lang={lang} className="font-value font-medium">
            Day 1 › Temp
          </span>
          .
        </p>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        {duplicates.size > 0 ? (
          <FormMessage tone="info">
            {plural(duplicates.size, "field")} share a name with another field. Put the header in front of each, like “Day 1 › Temp”, so you can
            tell them apart. Nothing is blocked.
          </FormMessage>
        ) : null}
      </div>

      {list.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
          No fields yet. Add one field for each column or answer box on the paper, using its name exactly as it&apos;s written.{" "}
          {FIELD_GUIDANCE[template.kind]} Or use <span className="font-medium">Propose fields</span> under the page to have the AI list them for
          you to check.
        </p>
      ) : (
        <DndContext
          id="template-fields"
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements: SILENT_ANNOUNCEMENTS, screenReaderInstructions: { draggable: SCREEN_READER_INSTRUCTIONS } }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={list.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col" aria-label="Fields in paper order">
              {rows}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {list.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Drag to reorder. With the keyboard, focus a handle and press Space, then ↑/↓ to move and Space to drop. Tick boxes that together give
          one answer, such as ကျား / မ, are combined on the Mapping tab with <span className="font-medium">From ticks</span>.
        </p>
      ) : null}
    </div>
  );
}

function FieldTypeSelect({ value, onChange, ariaLabel, className }: { value: string; onChange: (value: string) => void; ariaLabel: string; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO}>{FIELD_TYPE_LABELS.TEXT}</SelectItem>
        {/* Choice needs its choices, which only the properties panel can collect: set it there. */}
        {FIELD_TYPES.filter((t) => t !== "TEXT" && t !== "CHOICE").map((t) => (
          <SelectItem key={t} value={t}>
            {FIELD_TYPE_LABELS[t]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const handleClass =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 cursor-grab touch-none rounded outline-none focus-visible:ring-[3px]";

type FieldRowProps = {
  field: FieldView;
  isSequence: boolean;
  selected: boolean;
  /** Another live field has the same name. */
  duplicate: boolean;
  lang: string | undefined;
  onSelect: () => void;
};

function FieldRow({ field, isSequence, selected, duplicate, lang, onSelect }: FieldRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const warning = duplicate ? duplicateNameWarning(field.labelSource) : null;
  return (
    <li
      ref={setNodeRef}
      data-node={`field:${field.id}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative flex pb-1", ROW_SCROLL_MARGIN, isDragging && "z-10")}
    >
      <div
        className={cn(
          "bg-card flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5",
          selected && "border-foreground ring-foreground/15 ring-2",
          field.mode === "SKIP" && "bg-muted/40",
          isDragging && "shadow-md",
        )}
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag to move ${field.labelSource}`}
          className={handleClass}
        >
          <GripVertical className="size-4" />
        </button>
        <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className="min-w-0 flex-1 text-left">
          <FieldName name={field.labelSource} lang={lang} className="block font-medium" />
          {field.labelMeaning ? <span className="text-muted-foreground block text-xs break-words">{field.labelMeaning}</span> : null}
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {warning ? (
            <span role="img" title={warning} aria-label={warning} className="text-amber-600">
              <TriangleAlert className="size-4" />
            </span>
          ) : null}
          {isSequence ? <Badge variant="outline">Sequence</Badge> : null}
          <TypeChip type={field.dataType} />
          <ModeChip mode={field.mode} />
        </div>
      </div>
    </li>
  );
}
