import type { ValueState } from "@/lib/transform/types";

/**
 * CSV encoding for export (docs/01 §6.11). Pure and client-safe. Values go out exactly as stored: no number
 * parsing, no trimming, no spreadsheet-formula escaping (which would change the data people typed).
 */

/** Written once at the start so Excel reads the file as UTF-8 (docs/07 decision 22). */
export const BOM = "﻿";
export const CRLF = "\r\n";

export type ExportTokens = { blankToken: string; illegibleToken: string };

/** RFC 4180: quoted when it holds a comma, quote or line break, or starts or ends with a space; quotes doubled. */
export function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvLine(fields: string[]): string {
  return fields.map(csvField).join(",") + CRLF;
}

/**
 * What a cell exports as. Blank and unreadable use the book's tokens; a dash and not applicable are
 * written as `-` and `N/A` so the five meanings of docs/01 §11.6 stay distinct in the file.
 */
export function exportValue(cell: { value: string | null; state: ValueState } | undefined, tokens: ExportTokens): string {
  if (!cell) return tokens.blankToken;
  switch (cell.state) {
    case "ILLEGIBLE":
      return tokens.illegibleToken;
    case "DASH":
      return "-";
    case "NOT_APPLICABLE":
      return "N/A";
    case "EMPTY":
      return tokens.blankToken;
    case "OK":
      return cell.value === null || cell.value === "" ? tokens.blankToken : cell.value;
  }
}

/** A file name from the book name and date: letters and digits of any script kept, the rest dashed. */
export function exportFileName(bookName: string, date: Date): string {
  const base = bookName.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export";
  return `${base}-${date.toISOString().slice(0, 10)}.csv`;
}
