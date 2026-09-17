import { AppError } from "@/lib/errors";

/** Cursor over manual row order: `position` (a fractional key, code-unit order) then id. */

export function encodeCursor(position: string, id: string): string {
  return `${position}_${id}`;
}

export function decodeCursor(cursor: string): { position: string; id: string } {
  const at = cursor.indexOf("_");
  const position = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (at <= 0 || !/^[0-9A-Za-z]+$/.test(position) || !/^[a-z0-9]+$/.test(id)) {
    throw new AppError("VALIDATION", "The table is out of date. Refresh it.");
  }
  return { position, id };
}
