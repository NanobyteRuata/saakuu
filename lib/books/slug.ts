const MAX_BASE = 58; // leaves room for a "_NN" de-duplication suffix within the 64-char key limit

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Derives a column key from its label: lowercase ASCII snake case. Labels with no Latin
 * letters (e.g. Burmese) fall back to `column_<n>`. Never returns a key in `taken`.
 */
export function slugifyKey(label: string, taken: Iterable<string>, fallbackIndex: number): string {
  let base = label
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_BASE)
    .replace(/_+$/, "");
  if (!base) base = `column_${fallbackIndex}`;
  if (!/^[a-z]/.test(base)) base = `c_${base}`.slice(0, MAX_BASE);

  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
