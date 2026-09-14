import type { DATE_ERAS, NUMERAL_SYSTEMS } from "./schemas";

export const NUMERAL_SYSTEM_LABELS: Record<(typeof NUMERAL_SYSTEMS)[number], string> = {
  AUTO: "Detect per value",
  LATIN: "Latin (0–9)",
  MYANMAR: "Myanmar (၀–၉)",
};

export const DATE_ERA_LABELS: Record<(typeof DATE_ERAS)[number], string> = {
  GREGORIAN: "Gregorian",
  BUDDHIST: "Buddhist era (BE)",
  MYANMAR: "Myanmar calendar",
};

/** Narrows a Select's string value to one of the allowed options, or null. */
export function pickOption<T extends string>(options: readonly T[], value: string): T | null {
  return options.find((option) => option === value) ?? null;
}
