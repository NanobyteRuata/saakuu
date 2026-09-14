import { TEMPLATE_KIND_LABELS } from "@/lib/templates/labels";
import { TEMPLATE_KINDS, type TemplateKind } from "@/lib/templates/schemas";

const DESCRIPTIONS: Record<TemplateKind, string> = {
  FORM: "One document fills one row, like a registration or vaccination card.",
  TABLE: "One document holds many rows, like a ledger or register page.",
};

export function KindPicker({ value, onChange, disabled }: { value: TemplateKind; onChange: (k: TemplateKind) => void; disabled?: boolean }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Type</legend>
      {TEMPLATE_KINDS.map((kind) => (
        <label
          key={kind}
          className="has-[:checked]:border-foreground flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm"
        >
          <input
            type="radio"
            name="template-kind"
            value={kind}
            checked={value === kind}
            onChange={() => onChange(kind)}
            disabled={disabled}
            className="mt-1"
          />
          <span className="flex flex-col">
            <span className="font-medium">{TEMPLATE_KIND_LABELS[kind]}</span>
            <span className="text-muted-foreground">{DESCRIPTIONS[kind]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
