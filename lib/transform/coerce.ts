import { BUDDHIST_ERA_YEAR_FLOOR, matchEnumValue, MYANMAR_ERA_YEAR_CEILING, parseDate } from "./normalise";
import { cleanText, numericReading, parseNumberText, toLatinDigits } from "./numerals";
import type { BookSettings, Issue, TransformColumn } from "./types";

/**
 * Coercion to the output column's type (docs/03 §8 step 7). A value that doesn't fit keeps its text
 * and gets an error: data is never discarded to satisfy a type.
 */

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "✓", "✔", "√", "ticked", "ဟုတ်", "ဟုတ်ကဲ့", "ရှိ"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "✗", "✘", "×", "မဟုတ်", "မရှိ"]);

function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const error = (message: string): Issue => ({ severity: "ERROR", message });

function listValues(values: string[]): string {
  const shown = values.slice(0, 8).join(", ");
  return values.length > 8 ? `${shown} and ${values.length - 8} more` : shown;
}

export function coerceToColumn(text: string, column: TransformColumn, book: BookSettings): { text: string; issues: Issue[] } {
  switch (column.dataType) {
    case "TEXT":
      return { text, issues: [] };
    case "NUMBER": {
      const reading = numericReading(text, book.numeralSystem);
      const number = parseNumberText(reading.text);
      if (number === null) return { text, issues: [error(`“${text}” isn't a number.`)] };
      return { text: number, issues: reading.notes.map((message) => ({ severity: "WARNING", message })) };
    }
    case "INTEGER": {
      const reading = numericReading(text, book.numeralSystem);
      const number = parseNumberText(reading.text);
      if (number === null || !/^-?\d+(\.0+)?$/u.test(number)) return { text, issues: [error(`“${text}” isn't a whole number.`)] };
      return { text: number.replace(/\.0+$/u, ""), issues: reading.notes.map((message) => ({ severity: "WARNING", message })) };
    }
    case "DATE": {
      if (isIsoDate(text)) {
        // A DATE field has already converted its year to CE, so an ISO date normally passes as is. One still in
        // the book's era (a Buddhist-era year typed as ISO, or a Myanmar-era year) is converted once here.
        const year = Number(text.slice(0, 4));
        const unconverted = book.dateEra === "MYANMAR" ? year < MYANMAR_ERA_YEAR_CEILING : year >= BUDDHIST_ERA_YEAR_FLOOR;
        if (!unconverted) return { text, issues: [] };
      }
      const { iso, issues } = parseDate(text, book.dateEra);
      if (iso === null) return { text, issues: [...issues, error(`“${text}” isn't a date. Dates are read as day/month/year.`)] };
      return { text: iso, issues };
    }
    case "BOOLEAN": {
      const key = toLatinDigits(cleanText(text)).toLowerCase();
      if (TRUE_WORDS.has(key)) return { text: "true", issues: [] };
      if (FALSE_WORDS.has(key)) return { text: "false", issues: [] };
      return { text, issues: [error(`“${text}” isn't yes or no.`)] };
    }
    case "ENUM": {
      const value = matchEnumValue(text, column.enumValues);
      return value === null ? { text, issues: [error(`“${text}” isn't one of: ${listValues(column.enumValues)}.`)] } : { text: value, issues: [] };
    }
  }
}
