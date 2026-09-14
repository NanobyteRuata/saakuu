import { Badge } from "@/components/ui/badge";
import type { RunSummary } from "@/lib/templates/config-state";
import {
  CONFIG_STATE_LABELS,
  FIELD_MODE_HINTS,
  FIELD_MODE_LABELS,
  FIELD_TYPE_LABELS,
  runSummaryLabel,
  TEMPLATE_KIND_LABELS,
} from "@/lib/templates/labels";
import type { ConfigState, FieldMode, FieldType, TemplateKind } from "@/lib/templates/schemas";
import { cn } from "@/lib/utils";

/** Template and field chips. Every state is worded, never signalled by colour alone. */

export function KindBadge({ kind }: { kind: TemplateKind }) {
  return <Badge variant="outline">{TEMPLATE_KIND_LABELS[kind]}</Badge>;
}

export function ConfigBadge({ state }: { state: ConfigState }) {
  return (
    <Badge variant={state === "CONFLICTED" ? "destructive" : state === "READY" ? "secondary" : "outline"}>
      <span className="sr-only">Configuration: </span>
      {CONFIG_STATE_LABELS[state]}
    </Badge>
  );
}

export function RunBadge({ run }: { run: RunSummary }) {
  return (
    <Badge variant={run.state === "FAILED" ? "destructive" : run.state === "COMPLETE" ? "secondary" : "outline"}>
      <span className="sr-only">Extraction: </span>
      {runSummaryLabel(run)}
    </Badge>
  );
}

export function TypeChip({ type }: { type: FieldType }) {
  return (
    <Badge variant="outline" className="text-muted-foreground font-normal">
      {FIELD_TYPE_LABELS[type]}
    </Badge>
  );
}

export function ModeChip({ mode }: { mode: FieldMode }) {
  return (
    <Badge
      variant="outline"
      title={FIELD_MODE_HINTS[mode]}
      className={cn(
        mode === "SKIP" && "text-muted-foreground line-through",
        mode === "MANUAL" && "border-primary/50 bg-primary/10 text-primary",
      )}
    >
      {FIELD_MODE_LABELS[mode]}
    </Badge>
  );
}
