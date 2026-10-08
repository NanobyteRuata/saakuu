import { UNSET_AGE_UNIT, type AgeUnit, type DateFieldOptions, type MarkSymbols } from "@/lib/templates/schemas";

import { divDecimal, formatDecimal, rationalToDecimalText } from "./decimal";
import { cleanText, numericReading, parseNumberText, toLatinDigits } from "./numerals";
import type { BookSettings, DateEra, Issue, TransformField, ValueState } from "./types";

/**
 * Per-field-type normalisers (docs/03 §8 step 5). Each takes the verbatim reading and returns the
 * value mappings work with. Raw values are never modified; this runs again on every transform.
 */

export type MarkReading = { ticked: boolean | null; count: number | null };

export type NormValue = {
  text: string | null;
  state: ValueState;
  confidence: number | null;
  inherited: boolean;
  /** MARK fields only: whether it is ticked (null: can't tell) and a tally count. */
  mark: MarkReading | null;
  issues: Issue[];
};

export type RawReading = { valueText: string | null; state: ValueState; confidence: number | null; inherited: boolean };

const warn = (message: string): Issue => ({ severity: "WARNING", message });

// ---------- dates ----------

/** Buddhist era as counted in Myanmar and Thailand: CE = BE − 543. */
export const BUDDHIST_ERA_OFFSET = 543;
/** Myanmar era (ME): CE = ME + 638 from Thingyan in April; + 639 before it. The day and month are not converted. */
export const MYANMAR_ERA_OFFSET = 638;
/** At or above this, a year in a Gregorian or Buddhist-era book is a Buddhist-era year, not CE. */
export const BUDDHIST_ERA_YEAR_FLOOR = 2400;
/** Below this, a year in a Myanmar-calendar book is a Myanmar-era year, not CE. */
export const MYANMAR_ERA_YEAR_CEILING = 1800;
/**
 * The century a two-digit year is read in, in the book's own era, when a date field asks for it. Fixed
 * rather than taken from today's date, so rebuilding the same document years apart gives the same date.
 */
export const ERA_CENTURY_BASE: Record<DateEra, number> = { GREGORIAN: 2000, BUDDHIST: 2500, MYANMAR: 1300 };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Day/month/year (the Myanmar convention) or year-month-day, separated by `/`, `-` or `.`, any digits.
 * The year is converted to CE per the book's era. Null `iso` when it isn't a date we can read.
 */
export function parseDate(value: string, era: DateEra, options?: DateFieldOptions | null): { iso: string | null; issues: Issue[] } {
  const t = toLatinDigits(cleanText(value)).replace(/\s*([-/.])\s*/gu, "$1");
  let parts: [number, number, number] | null = null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(t);
  if (m) parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/u.exec(t);
  if (m) parts = [Number(m[3]), Number(m[2]), Number(m[1])];
  const short = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/u.exec(t);
  if (short) {
    // Written without a century. A date field can say which century its register uses (docs/07 decision 36).
    const written = Number(short[3]);
    const pivotYear = options?.pivotYear ?? null;
    // A pivot rule without its year can't decide the century, so it is treated like no rule at all.
    const rule = options?.twoDigitYear === "PIVOT" && pivotYear === null ? "REFUSE" : (options?.twoDigitYear ?? "REFUSE");
    if (rule === "REFUSE") {
      return { iso: null, issues: [warn(`“${cleanText(value)}” has a two-digit year, so the century isn't known.`)] };
    }
    const base = ERA_CENTURY_BASE[era];
    const century = rule === "PIVOT" && pivotYear !== null && written >= pivotYear ? base - 100 : base;
    parts = [century + written, Number(short[2]), Number(short[1])];
  }
  if (!parts) return { iso: null, issues: [] };

  const issues: Issue[] = [];
  const [written, month, day] = parts;
  let year = written;
  if (era === "BUDDHIST") {
    year -= BUDDHIST_ERA_OFFSET;
  } else if (era === "MYANMAR") {
    year += MYANMAR_ERA_OFFSET;
    issues.push(warn(`Converted from the Myanmar-era year ${parts[0]} to ${year}. Dates before Thingyan (mid-April) belong to ${year + 1}; check it.`));
  } else if (year >= BUDDHIST_ERA_YEAR_FLOOR) {
    issues.push(warn(`The year ${year} looks like a Buddhist-era year. If this paper uses Buddhist-era dates, say so from this column's menu in the table.`));
  }
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { iso: null, issues: [] };
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { iso, issues };
}

// ---------- ages and fractions ----------

type Rational = { num: bigint; den: bigint };

function rationalOf(text: string): Rational | null {
  const m = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { num: BigInt(`${m[1]}${frac}`), den: BigInt(10) ** BigInt(frac.length) };
}

/** `1 1/2`, `3/4`, `1.5`, `2` as an exact rational. */
function parseMixedNumber(text: string): Rational | null {
  let m = /^(\d+) (\d+)\/(\d+)$/u.exec(text);
  if (m) {
    const den = BigInt(m[3] ?? "0");
    if (den === BigInt(0)) return null;
    return { num: BigInt(m[1] ?? "0") * den + BigInt(m[2] ?? "0"), den };
  }
  m = /^(\d+)\/(\d+)$/u.exec(text);
  if (m) {
    const den = BigInt(m[2] ?? "0");
    return den === BigInt(0) ? null : { num: BigInt(m[1] ?? "0"), den };
  }
  return rationalOf(text);
}

function compactFractionText(value: string): string {
  return toLatinDigits(cleanText(value)).replace(/\s*\/\s*/gu, "/");
}

const YEAR_WORDS = "y|yr|yrs|year|years|နှစ်";
const MONTH_WORDS = "m|mo|mos|month|months|လ";
const UNIT_AGE = new RegExp(`^(?:(\\d+(?:\\.\\d+)?) ?(?:${YEAR_WORDS}))? ?(?:(\\d+(?:\\.\\d+)?) ?(?:${MONTH_WORDS}))?$`, "u");

/** Decimals kept when an age isn't an exact number of years (`4/12` → 0.33). */
const AGE_YEAR_PLACES = 2;

/**
 * An age's total months, exactly (docs/01 §11.8). Numbers are years, so `1 1/2` is 18 months, `4/12` is 4
 * months and `2` is 24 months; `1y 6m` and `1 နှစ် 6 လ` are read by their units.
 */
function ageMonths(value: string): Rational | null {
  const t = compactFractionText(value).toLowerCase();
  const twelve = BigInt(12);
  const unit = UNIT_AGE.exec(t);
  if (unit && (unit[1] !== undefined || unit[2] !== undefined)) {
    const years = unit[1] === undefined ? { num: BigInt(0), den: BigInt(1) } : rationalOf(unit[1]);
    const months = unit[2] === undefined ? { num: BigInt(0), den: BigInt(1) } : rationalOf(unit[2]);
    if (!years || !months) return null;
    return { num: years.num * twelve * months.den + months.num * years.den, den: years.den * months.den };
  }
  const years = parseMixedNumber(t);
  return years ? { num: years.num * twelve, den: years.den } : null;
}

/**
 * An age in the field's unit: years (`1 1/2` → 1.5), total months (18) or both (`1y 6m`). Years that don't
 * come out exact are rounded to AGE_YEAR_PLACES and say so. Null when unreadable, or when the unit shows
 * months and they don't come out exact.
 */
export function parseAge(value: string, unit: AgeUnit): { text: string; rounded: boolean } | null {
  const total = ageMonths(value);
  if (!total) return null;
  const perYear = total.den * BigInt(12);
  switch (unit) {
    case "MONTHS": {
      const months = rationalToDecimalText(total.num, total.den);
      return months === null ? null : { text: months, rounded: false };
    }
    case "YEARS": {
      const exact = rationalToDecimalText(total.num, perYear);
      if (exact !== null) return { text: exact, rounded: false };
      const rounded = divDecimal({ units: total.num, scale: 0 }, { units: perYear, scale: 0 }, AGE_YEAR_PLACES);
      return rounded ? { text: formatDecimal(rounded), rounded: true } : null;
    }
    case "YEARS_MONTHS": {
      const years = total.num / perYear;
      const rest = rationalToDecimalText(total.num - years * perYear, total.den);
      return rest === null ? null : { text: `${years}y ${rest}m`, rounded: false };
    }
  }
}

/** A fraction as exact decimal text (`1 1/2` → `1.5`), or the tidy fraction when it doesn't terminate (`1/3`). */
export function parseFraction(value: string): string | null {
  const t = compactFractionText(value);
  const r = parseMixedNumber(t);
  if (!r) return null;
  return rationalToDecimalText(r.num, r.den) ?? t;
}

// ---------- choices ----------

function choiceKey(value: string): string {
  return toLatinDigits(cleanText(value)).toLowerCase().replace(/\s+/gu, "");
}

function editDistanceAtMostOne(a: string[], b: string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The declared choice this reading is: exact (ignoring case, spaces and numeral script) or one character off. */
export function matchChoice(value: string, choices: string[]): { choice: string; exact: boolean } | null {
  const key = choiceKey(value);
  const exact = choices.find((c) => choiceKey(c) === key);
  if (exact !== undefined) return { choice: exact, exact: true };
  const chars = Array.from(key);
  if (chars.length < 3) return null;
  const near = choices.filter((c) => editDistanceAtMostOne(chars, Array.from(choiceKey(c))));
  return near.length === 1 && near[0] !== undefined ? { choice: near[0], exact: false } : null;
}

/** Declared enum value for a reading, ignoring case, spaces and numeral script. */
export function matchEnumValue(value: string, values: string[]): string | null {
  const key = choiceKey(value);
  return values.find((v) => choiceKey(v) === key) ?? null;
}

// ---------- marks ----------

const TALLY_STROKES = new Map<string, number>([
  ["|", 1],
  ["/", 1],
  ["\\", 1],
  ["1", 1],
  ["l", 1],
  ["I", 1],
  ["丨", 1],
  ["卌", 5],
]);

function countTally(text: string): number | null {
  const chars = Array.from(text.replace(/\s+/gu, ""));
  if (chars.length === 0) return null;
  let total = 0;
  for (const ch of chars) {
    const n = TALLY_STROKES.get(ch);
    if (n === undefined) return null;
    total += n;
  }
  return total;
}

/**
 * A tick column's reading per the field's symbol meanings (docs/01 §11.7). Without symbols, anything
 * written counts as ticked. A symbol meaning `count` counts repeats of itself; the symbol `tally`
 * counts tally strokes. `ticked: null` means the mark isn't one of the declared symbols.
 */
export function readMark(text: string, symbols: MarkSymbols | null): MarkReading {
  const entries = Object.entries(symbols ?? {});
  if (entries.length === 0) return { ticked: true, count: null };
  const value = cleanText(text);
  const lower = value.toLowerCase();
  for (const [symbol, meaning] of entries) {
    const s = cleanText(symbol);
    if (s === value || s.toLowerCase() === lower) {
      return meaning === "count" ? { ticked: true, count: 1 } : { ticked: meaning, count: null };
    }
  }
  for (const [symbol, meaning] of entries) {
    if (meaning !== "count") continue;
    const s = cleanText(symbol);
    let count: number | null = null;
    if (s.toLowerCase() === "tally") count = countTally(value);
    else if (s !== "" && value.replace(/\s+/gu, "").split(s).every((part) => part === "")) {
      count = value.replace(/\s+/gu, "").length / s.length;
    }
    if (count === null && /^\d+$/u.test(toLatinDigits(value))) count = Number(toLatinDigits(value));
    if (count !== null) return { ticked: count > 0, count };
  }
  return { ticked: null, count: null };
}

// ---------- entry point ----------

/** Normalises one reading for its field's type. */
export function normaliseReading(field: TransformField, raw: RawReading, book: BookSettings): NormValue {
  const base = { confidence: raw.confidence, inherited: raw.inherited, issues: [] as Issue[], mark: null };
  const isMark = field.dataType === "MARK";
  if (raw.state !== "OK") {
    // A blank, dash or n/a tick column is not ticked; an unreadable one can't be told.
    const mark = isMark ? { ticked: raw.state === "ILLEGIBLE" ? null : false, count: null } : null;
    return { ...base, text: null, state: raw.state, mark };
  }
  const cleaned = cleanText(raw.valueText ?? "");
  if (cleaned === "") return { ...base, text: null, state: "EMPTY", mark: isMark ? { ticked: false, count: null } : null };
  const ok = (text: string, issues: Issue[] = []): NormValue => ({ ...base, text, state: "OK", issues });

  switch (field.dataType) {
    case "TEXT":
      return ok(cleaned);
    case "NUMBER":
    case "INTEGER": {
      const reading = numericReading(cleaned, book.numeralSystem);
      const number = parseNumberText(reading.text);
      return number === null ? ok(reading.text) : ok(number, reading.notes.map(warn));
    }
    case "DATE": {
      const { iso, issues } = parseDate(cleaned, book.dateEra, field.typeOptions?.date);
      return ok(iso ?? toLatinDigits(cleaned), issues);
    }
    case "AGE": {
      const age = parseAge(cleaned, field.typeOptions?.age?.unit ?? UNSET_AGE_UNIT);
      if (age === null) return ok(toLatinDigits(cleaned), [warn(`“${cleaned}” isn't an age we can read, such as 1 1/2, 4/12 or 2.`)]);
      return ok(
        age.text,
        age.rounded ? [warn(`“${cleaned}” isn't an exact number of years, so it is rounded to ${age.text}. Show this age as months to keep it exact.`)] : [],
      );
    }
    case "FRACTION": {
      const fraction = parseFraction(cleaned);
      return fraction === null ? ok(toLatinDigits(cleaned), [warn(`“${cleaned}” isn't a fraction we can read, such as 1 1/2 or 3/4.`)]) : ok(fraction);
    }
    case "CHOICE": {
      if (field.choices.length === 0) return ok(cleaned);
      const match = matchChoice(cleaned, field.choices);
      if (!match) return ok(cleaned, [warn(`“${cleaned}” isn't one of the choices.`)]);
      return ok(match.choice, match.exact ? [] : [warn(`Read as “${cleaned}” and matched to the choice “${match.choice}”.`)]);
    }
    case "MARK": {
      const mark = readMark(cleaned, field.markSymbols);
      if (mark.ticked === null) {
        return { ...ok(cleaned, [warn(`“${cleaned}” isn't one of the mark symbols set for this field.`)]), mark };
      }
      const text = mark.count !== null ? String(mark.count) : mark.ticked ? "true" : "false";
      return { ...ok(text), mark };
    }
  }
}
