import type { NumeralSystem } from "./types";

/**
 * Text and numeral normalisation (docs/03 §8 step 5). The AI transcribes digits in the script they
 * were written in; this is where they become Latin digits, deterministically.
 */

/** Unicode NFC, runs of whitespace collapsed to one space, trimmed. */
export function cleanText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Myanmar (၀–၉) and Shan (႐–႙) digits to Latin 0–9. Everything else is untouched. */
export function toLatinDigits(value: string): string {
  return value.replace(/[၀-၉႐-႙]/gu, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x1090 ? code - 0x1090 : code - 0x1040);
  });
}

const NUMERIC_LOOKING = /^[-+]?[\d\s.,/]*\d[\d\s.,/]*$/u;
const MYANMAR_DIGIT = /[၀-၉]/u;
const LATIN_DIGIT = /[0-9]/u;
/** The Myanmar letter wa (ဝ) is drawn exactly like the digit zero (၀). */
const MYANMAR_WA = /ဝ/gu;
const LATIN_LOOKALIKES: [RegExp, string, string][] = [
  [/[Oo]/gu, "0", "O"],
  [/[lI|]/gu, "1", "l"],
];

/**
 * A value read in a numeric context: digits converted to Latin, plus look-alike letters read as
 * digits when that makes the whole value a number. Which look-alikes apply follows the book's numeral
 * system: Myanmar (wa → 0), Latin (O → 0, l/I → 1), or, for Auto, the script of the digits already in
 * the value. Latin look-alikes are reported in `notes`; wa is not, because the glyphs are identical.
 */
export function numericReading(value: string, system: NumeralSystem): { text: string; notes: string[] } {
  const text = cleanText(value);
  const plain = toLatinDigits(text);
  if (NUMERIC_LOOKING.test(plain)) return { text: plain, notes: [] };

  const myanmar = system === "MYANMAR" || (system === "AUTO" && MYANMAR_DIGIT.test(text));
  const latin = system === "LATIN" || (system === "AUTO" && LATIN_DIGIT.test(text));
  let candidate = text;
  const notes: string[] = [];
  if (myanmar) candidate = candidate.replace(MYANMAR_WA, "၀");
  if (latin) {
    for (const [pattern, digit, shown] of LATIN_LOOKALIKES) {
      if (pattern.test(candidate)) {
        candidate = candidate.replace(pattern, digit);
        notes.push(`Read the letter “${shown}” as ${digit}.`);
      }
    }
  }
  const converted = toLatinDigits(candidate);
  return NUMERIC_LOOKING.test(converted) ? { text: converted, notes } : { text: plain, notes: [] };
}

/**
 * A plain decimal number as canonical text: sign, no leading zeros, `.` for decimals, thousands
 * commas removed (`1,234.50` → `1234.50`). Trailing decimal zeros are kept. Null when not a number.
 */
export function parseNumberText(value: string): string | null {
  const t = value.replace(/\s+/gu, "");
  const m = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/u.exec(t);
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  const sign = m[1] === "-" ? "-" : "";
  const whole = (m[2] ?? "0").replace(/,/gu, "").replace(/^0+(?=\d)/u, "");
  const frac = m[3];
  const isZero = /^0$/u.test(whole) && (frac === undefined || /^0+$/u.test(frac));
  return `${isZero ? "" : sign}${whole}${frac !== undefined ? `.${frac}` : ""}`;
}
