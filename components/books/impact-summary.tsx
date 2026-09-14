import { Badge } from "@/components/ui/badge";
import { formatCount, plural } from "@/lib/format";
import type { ImpactReport } from "@/lib/impact";

/** Exact blast radius of a destructive change (docs/01 §8). Never rounds, never says "some". */
export function ImpactSummary({ report, columnLabels }: { report: ImpactReport; columnLabels: Map<string, string> }) {
  const cleared = report.clearedColumns.map((id) => ({ id, label: columnLabels.get(id) ?? "A deleted column" }));
  const edited = report.editedCells;

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="impact-summary">
      <div className="flex items-center gap-2">
        <Badge variant="destructive">Destructive</Badge>
        <span className="text-muted-foreground">Existing data can be lost. Nothing changes until you confirm.</span>
      </div>

      {cleared.length > 0 ? (
        <div>
          <h3 className="font-medium">{cleared.length === 1 ? "Column deleted" : `${formatCount(cleared.length)} columns deleted`}</h3>
          <ul className="mt-1 list-disc pl-5">
            {cleared.map((c) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>Column types change: existing values will be re-checked, and ones that don&apos;t fit will be flagged.</p>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Affected rows", report.affectedRows],
          ["Affected cells", report.affectedCells],
          ["Edited by you", report.editedCells],
          ["Marked reviewed", report.reviewedCells],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border px-3 py-2">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCount(Number(value))}</dd>
          </div>
        ))}
      </dl>

      <p className="font-medium">
        {formatCount(edited)} of the {plural(report.affectedCells, "affected cell")} {edited === 1 ? "has" : "have"} been
        edited by you.
      </p>

      {report.brokenMappings.length === 0 ? (
        <p>No template mappings break.</p>
      ) : (
        <div>
          <h3 className="font-medium">{plural(report.brokenMappings.length, "template mapping")} will break</h3>
          <ul className="mt-1 list-disc pl-5">
            {report.brokenMappings.map((m, i) => (
              <li key={`${m.templateId}-${i}`}>
                {m.templateName} → {m.columnLabel}: {m.reason}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-1">
            Those templates show as Conflicted until their mappings are fixed. Their other mappings keep working.
          </p>
        </div>
      )}
    </div>
  );
}
