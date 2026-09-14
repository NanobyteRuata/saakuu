"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { EditorColumn } from "@/lib/books/column-diff";
import { pickOption } from "@/lib/books/labels";
import { COLUMN_TYPE_LABELS, COLUMN_TYPES, columnDraftSchema, MAX_COLUMNS, type ColumnType } from "@/lib/books/schemas";
import { slugifyKey } from "@/lib/books/slug";
import { cn } from "@/lib/utils";

export function newEditorColumn(): EditorColumn {
  return {
    uid: `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    id: null,
    key: "",
    label: "",
    dataType: "TEXT",
    enumValues: [],
    isRequired: false,
  };
}

export function toEditorColumn(column: Omit<EditorColumn, "uid" | "id"> & { id: string }): EditorColumn {
  return {
    uid: column.id,
    id: column.id,
    key: column.key,
    label: column.label,
    dataType: column.dataType,
    enumValues: column.enumValues,
    isRequired: column.isRequired,
  };
}

/** Plain-language problem per column uid. Mirrors the server rules so most mistakes never round-trip. */
export function validateColumns(columns: EditorColumn[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  columns.forEach((col, i) => {
    const name = col.label.trim() || `Column ${i + 1}`;
    const parsed = columnDraftSchema.safeParse(col);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors[col.uid] =
        issue?.path[0] === "label" ? `${name}: add a label.` : `${name}: ${issue?.message ?? "check this column."}`;
    } else if (seen.has(parsed.data.key)) {
      errors[col.uid] = `${name}: another column already uses the key "${parsed.data.key}".`;
    }
    seen.add(col.key.trim());
  });
  return errors;
}

type Props = {
  columns: EditorColumn[];
  onChange: (columns: EditorColumn[]) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
};

/**
 * Ordered, drag-reorderable list of output columns. The drag handle also reorders from the
 * keyboard (Space to lift, arrow keys to move, Space to drop). Keys auto-follow the label only
 * for new columns whose key hasn't been typed by hand; an existing column's key never changes on rename.
 */
export function ColumnListEditor({ columns, onChange, errors = {}, disabled = false }: Props) {
  const [manualKeys, setManualKeys] = useState<Set<string>>(() => new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const update = (uid: string, patch: Partial<EditorColumn>) =>
    onChange(columns.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = columns.findIndex((c) => c.uid === active.id);
    const to = columns.findIndex((c) => c.uid === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(columns, from, to));
  };

  return (
    <div className="flex flex-col gap-3">
      <DndContext id="output-columns" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={columns.map((c) => c.uid)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-2" aria-label="Output columns">
            {columns.map((column, index) => (
              <ColumnRow
                key={column.uid}
                column={column}
                index={index}
                error={errors[column.uid]}
                disabled={disabled}
                onLabel={(label) => {
                  const patch: Partial<EditorColumn> = { label };
                  if (column.id === null && !manualKeys.has(column.uid)) {
                    const others = columns.filter((c) => c.uid !== column.uid).map((c) => c.key);
                    patch.key = label.trim() ? slugifyKey(label, others, index + 1) : "";
                  }
                  update(column.uid, patch);
                }}
                onKey={(key) => {
                  setManualKeys((prev) => new Set(prev).add(column.uid));
                  update(column.uid, { key });
                }}
                onType={(dataType) =>
                  update(column.uid, { dataType, enumValues: dataType === "ENUM" ? column.enumValues : [] })
                }
                onRequired={(isRequired) => update(column.uid, { isRequired })}
                onEnumValues={(enumValues) => update(column.uid, { enumValues })}
                onRemove={() => onChange(columns.filter((c) => c.uid !== column.uid))}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => onChange([...columns, newEditorColumn()])}
        disabled={disabled || columns.length >= MAX_COLUMNS}
      >
        <Plus />
        Add column
      </Button>
    </div>
  );
}

type RowProps = {
  column: EditorColumn;
  index: number;
  error: string | undefined;
  disabled: boolean;
  onLabel: (label: string) => void;
  onKey: (key: string) => void;
  onType: (type: ColumnType) => void;
  onRequired: (required: boolean) => void;
  onEnumValues: (values: string[]) => void;
  onRemove: () => void;
};

function ColumnRow({ column, index, error, disabled, ...on }: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: column.uid,
    disabled,
  });
  const n = index + 1;
  const name = column.label.trim() || `column ${n}`;
  const errorId = `${column.uid}-error`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-card rounded-lg border p-3",
        isDragging && "relative z-10 shadow-md",
        error && "border-destructive/60",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder ${name}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-2 cursor-grab touch-none rounded outline-none focus-visible:ring-[3px]"
        >
          <GripVertical className="size-4" />
        </button>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_11rem]">
          <Input
            aria-label={`Column ${n} label`}
            placeholder="Label, e.g. Date of birth"
            value={column.label}
            onChange={(e) => on.onLabel(e.target.value)}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <Input
            aria-label={`Column ${n} key`}
            placeholder="csv_header_key"
            className="font-mono"
            value={column.key}
            onChange={(e) => on.onKey(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          <Select
            value={column.dataType}
            onValueChange={(value) => {
              const type = pickOption(COLUMN_TYPES, value);
              if (type) on.onType(type);
            }}
            disabled={disabled}
          >
            <SelectTrigger aria-label={`Column ${n} type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COLUMN_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {COLUMN_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <label className="text-muted-foreground mr-1 flex h-9 items-center gap-1.5 text-sm">
            <Checkbox
              checked={column.isRequired}
              onCheckedChange={(checked) => on.onRequired(checked === true)}
              aria-label={`Column ${n} required`}
              disabled={disabled}
            />
            Required
          </label>
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={on.onRemove} disabled={disabled}>
            <Trash2 />
          </Button>
        </div>
      </div>
      {column.dataType === "ENUM" ? (
        <EnumValuesEditor n={n} values={column.enumValues} onChange={on.onEnumValues} disabled={disabled} />
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-destructive mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function EnumValuesEditor({
  n,
  values,
  onChange,
  disabled,
}: {
  n: number;
  values: string[];
  onChange: (values: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    onChange([...values, ...parts.filter((p, i) => !values.includes(p) && parts.indexOf(p) === i)]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
      <span className="text-muted-foreground text-sm">Values:</span>
      {values.map((value) => (
        <span key={value} className="bg-secondary font-value inline-flex items-center gap-1 rounded px-2 py-0.5 text-sm">
          {value}
          <button
            type="button"
            aria-label={`Remove value ${value}`}
            onClick={() => onChange(values.filter((v) => v !== value))}
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Input
        aria-label={`Column ${n} list values`}
        placeholder="Add a value, then press Enter"
        className="h-8 w-56"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        disabled={disabled}
      />
    </div>
  );
}
