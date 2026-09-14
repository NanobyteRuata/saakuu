const counts = new Intl.NumberFormat("en-US");

/** 1203 → "1,203". */
export function formatCount(n: number): string {
  return counts.format(n);
}

/** plural(2, "book") → "2 books". Always exact numbers, never "some" or "many". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
}

/** UI dates are ISO `YYYY-MM-DD`. */
export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}
