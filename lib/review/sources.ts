import type { FieldList } from "@/lib/templates/field-list";
import type { TransformMapping } from "@/lib/transform/types";
import type { Bbox } from "@/lib/table/types";

/**
 * Where on the photo each cell of a row was read (docs/05 §13). A cell has no link to raw values of its own;
 * it is filled by its column's working mapping, so its region is the union of the boxes of the fields that
 * mapping reads (a From ticks mapping reads all of its tick fields). Pure.
 */

export type CellSource = {
  /** The photo the region is on; null when nothing read for this cell has a box. */
  photoId: string | null;
  bbox: Bbox | null;
  /** Names of the fields read, e.g. "RDT Test › Positive › A". Empty for constants and expressions without inputs. */
  paths: string[];
  /**
   * The text as written on the paper, when the cell is read from exactly one field that was read as text (Phase 19).
   * The glossary explains what people wrote, so this — a ditto mark, not the value it was resolved to — is the term
   * review offers it.
   */
  written: string | null;
};

export type RegionValue = { fieldId: string; photoId: string | null; bbox: Bbox | null; valueText: string | null };

export function unionBbox(boxes: Bbox[]): Bbox | null {
  if (boxes.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Regions by column id for one record. `working` is the column → mapping choice the transform made
 * (`firstWorkingMappings`). Boxes on a page other than the record's own are left out when the record has a page,
 * so the highlight never points at the wrong photo.
 */
export function cellSources(fields: FieldList, working: Map<string, TransformMapping>, values: RegionValue[], recordPhotoId: string | null): Record<string, CellSource> {
  const byField = new Map(values.map((v) => [v.fieldId, v]));
  const out: Record<string, CellSource> = {};
  for (const [columnId, mapping] of working) {
    const fieldIds = mapping.inputs.map((i) => i.fieldId);
    const read = fieldIds.flatMap((id) => {
      const v = byField.get(id);
      return v?.bbox && (recordPhotoId === null || v.photoId === null || v.photoId === recordPhotoId) ? [v] : [];
    });
    const photoId = recordPhotoId ?? read.find((v) => v.photoId !== null)?.photoId ?? null;
    const boxes = read.filter((v) => v.photoId === null || v.photoId === photoId).flatMap((v) => (v.bbox ? [v.bbox] : []));
    const only = fieldIds.length === 1 && fieldIds[0] !== undefined ? byField.get(fieldIds[0]) : undefined;
    out[columnId] = {
      photoId,
      bbox: unionBbox(boxes),
      paths: fieldIds.flatMap((id) => fields.byId.get(id)?.labelSource ?? []),
      written: only?.valueText?.trim() || null,
    };
  }
  return out;
}
