"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { flattenTree, type Tree } from "@/lib/templates/tree";
import type { FieldView, GroupView } from "@/lib/templates/views";
import { cn } from "@/lib/utils";

const TOP = "top";

type Props = {
  id?: string;
  ariaLabel?: string;
  className?: string;
  tree: Tree<GroupView, FieldView>;
  /** Parent group id; null = top level. */
  value: string | null;
  onChange: (parentId: string | null) => void;
  /** Parents that can't be chosen (e.g. too deep, or a group that would refuse the item); null = top level. */
  isDisabled?: (groupId: string | null) => boolean;
  disabled?: boolean;
  lang: string | undefined;
};

/** Picks a parent: the top level or any group, indented as in the tree. The non-drag way to move. */
export function ParentGroupSelect({ id, ariaLabel, className, tree, value, onChange, isDisabled, disabled, lang }: Props) {
  const groups = flattenTree(tree).flatMap((n) => (n.kind === "group" ? [n] : []));
  return (
    // Radix can report "" while a just-added group's item mounts; ignore it rather than falling back to the top level.
    <Select
      value={value !== null && tree.groups.has(value) ? value : TOP}
      onValueChange={(v) => v && onChange(v === TOP ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("w-full", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TOP} disabled={isDisabled?.(null) ?? false}>
          Top level
        </SelectItem>
        {groups.map((g) => (
          <SelectItem key={g.id} value={g.id} disabled={isDisabled?.(g.id) ?? false}>
            <span lang={lang} className="font-value" style={{ paddingLeft: `${g.depth * 0.75}rem` }}>
              {g.group.labelSource}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
