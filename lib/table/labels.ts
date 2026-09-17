import type { VoidReason } from "@/lib/transform/types";

/** Why a row is void, as shown next to it: "Total, void". */
export const VOID_REASON_LABELS: Record<VoidReason, string> = {
  SUBTOTAL: "Subtotal",
  TOTAL: "Total",
  NOTE: "Note",
  STRUCK_THROUGH: "Struck through",
  ORPHANED: "Unmatched",
};

export function voidLabel(voidReason: string | null): string {
  const label = voidReason !== null && voidReason in VOID_REASON_LABELS ? VOID_REASON_LABELS[voidReason as VoidReason] : null;
  return label ? `${label}, void` : "Void";
}
