"use client";

import { useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteJson, getJson } from "@/lib/api-client";
import { plural } from "@/lib/format";
import type { GroupDeleteImpact } from "@/lib/templates/structure-service";
import type { GroupView } from "@/lib/templates/views";

/** "2 fields and 1 group move up into “RDT Test”. No fields are deleted." */
export function groupDeleteSummary(impact: Pick<GroupDeleteImpact, "fields" | "groups" | "parentLabel">): string {
  const parts: string[] = [];
  if (impact.fields > 0) parts.push(plural(impact.fields, "field"));
  if (impact.groups > 0) parts.push(plural(impact.groups, "group"));
  if (parts.length === 0) return "The group is empty, so nothing moves. No fields are deleted.";
  const where = impact.parentLabel ? `into “${impact.parentLabel}”` : "to the top level";
  const verb = impact.fields + impact.groups === 1 ? "moves" : "move";
  return `${parts.join(" and ")} ${verb} up ${where}, in the group's place and in the same order. No fields are deleted.`;
}

type Props = {
  group: GroupView | null;
  lang: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (group: GroupView, summary: string) => void | Promise<void>;
};

/** Counted confirmation for deleting a group. Confirm stays disabled until the counts load. */
export function DeleteGroupDialog({ group, lang, open, onOpenChange, onDeleted }: Props) {
  const [impact, setImpact] = useState<GroupDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const id = group?.id;

  // Clear old errors when the dialog opens, but not on a re-count, so a conflict message stays visible.
  useEffect(() => {
    if (open) setError(null);
  }, [open, id]);

  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    setImpact(null);
    void getJson<GroupDeleteImpact>(`/api/groups/${id}/delete-impact`).then((result) => {
      if (cancelled) return;
      if (result.ok) setImpact(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, id, reload]);

  async function confirm() {
    if (!impact || !group) return;
    setPending(true);
    const result = await deleteJson<{ movedFields: number; movedGroups: number }>(`/api/groups/${group.id}`, {
      impactHash: impact.impactHash,
      confirm: true,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      // The group changed since the counts were shown: count again so the next confirm is accurate.
      if (result.error.code === "CONFLICT") setReload((n) => n + 1);
      return;
    }
    onOpenChange(false);
    await onDeleted(group, groupDeleteSummary({ fields: result.data.movedFields, groups: result.data.movedGroups, parentLabel: impact.parentLabel }));
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete the group “<span lang={lang} className="font-value">{group?.labelSource}</span>”?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2" data-testid="group-delete-impact">
              {impact ? (
                <>
                  <p>{groupDeleteSummary(impact)}</p>
                  {impact.deletedFields > 0 ? (
                    <p>
                      {plural(impact.deletedFields, "deleted field")} from this group{" "}
                      {impact.deletedFields === 1 ? "restores" : "restore"}{" "}
                      {impact.parentLabel ? `into “${impact.parentLabel}”` : "at the top level"} instead.
                    </p>
                  ) : null}
                </>
              ) : error ? null : (
                <p>Counting what this affects…</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={confirm} disabled={!impact || pending}>
            {pending ? "Deleting…" : "Delete group"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
