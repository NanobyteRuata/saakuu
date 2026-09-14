import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

import { FIELD_TYPE_LABELS } from "./labels";
import type { FieldMode, FieldType, GroupSelection } from "./schemas";

/**
 * The source layer as a tree (docs/02 invariants 9–12). Pure and client-safe: the editor, the
 * services and later the prompt builder and review labels all read structure through here.
 *
 * Groups are the headers on the paper; fields are the columns and answer boxes. Under one parent
 * (the template root or a group) child groups and fields share one fractional position space.
 */

export const MAX_GROUP_DEPTH = 3;

export type NodeKind = "field" | "group";
export type SiblingRef = { kind: NodeKind; id: string };
export type Sibling = SiblingRef & { position: string };

type Positioned = { id: string; position: string };

/** Fractional keys compare by code unit, not locale; ties broken by id. */
export function compareSiblings(a: Positioned, b: Positioned): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sameRef(a: SiblingRef | null, b: SiblingRef | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

export type TreeGroup = {
  id: string;
  parentGroupId: string | null;
  labelSource: string;
  labelMeaning: string | null;
  position: string;
  selection: GroupSelection;
};

export type TreeField = {
  id: string;
  groupId: string | null;
  labelSource: string;
  labelMeaning: string | null;
  position: string;
  dataType: FieldType;
  mode: FieldMode;
};

export type GroupNode<G extends TreeGroup = TreeGroup, F extends TreeField = TreeField> = {
  kind: "group";
  id: string;
  group: G;
  parentId: string | null;
  /** Groups above this node: 0 at the top level. */
  depth: number;
  children: TreeNode<G, F>[];
};

export type FieldNode<F extends TreeField = TreeField> = {
  kind: "field";
  id: string;
  field: F;
  parentId: string | null;
  depth: number;
};

export type TreeNode<G extends TreeGroup = TreeGroup, F extends TreeField = TreeField> = GroupNode<G, F> | FieldNode<F>;

export type Tree<G extends TreeGroup = TreeGroup, F extends TreeField = TreeField> = {
  roots: TreeNode<G, F>[];
  groups: Map<string, GroupNode<G, F>>;
  fields: Map<string, FieldNode<F>>;
};

export function nodePosition(node: TreeNode): Positioned {
  return node.kind === "group" ? node.group : node.field;
}

export function toSibling(node: TreeNode): Sibling {
  return { kind: node.kind, id: node.id, position: nodePosition(node).position };
}

/** Builds the ordered tree from flat rows. A missing parent or a loop puts a node at the top level instead of losing it. */
export function buildTree<G extends TreeGroup, F extends TreeField>(groups: G[], fields: F[]): Tree<G, F> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parentOf = (g: G): string | null => {
    const first = g.parentGroupId;
    if (first === null || !byId.has(first)) return null;
    const seen = new Set([g.id]);
    let p: string | null = first;
    while (p !== null && byId.has(p)) {
      if (seen.has(p)) return null;
      seen.add(p);
      p = byId.get(p)?.parentGroupId ?? null;
    }
    return first;
  };

  const tree: Tree<G, F> = { roots: [], groups: new Map(), fields: new Map() };
  for (const g of groups) {
    tree.groups.set(g.id, { kind: "group", id: g.id, group: g, parentId: parentOf(g), depth: 0, children: [] });
  }
  const attach = (node: TreeNode<G, F>) => {
    const parent = node.parentId === null ? undefined : tree.groups.get(node.parentId);
    (parent ? parent.children : tree.roots).push(node);
  };
  for (const node of tree.groups.values()) attach(node);
  for (const f of fields) {
    const parentId = f.groupId !== null && tree.groups.has(f.groupId) ? f.groupId : null;
    const node: FieldNode<F> = { kind: "field", id: f.id, field: f, parentId, depth: 0 };
    tree.fields.set(f.id, node);
    attach(node);
  }
  const walk = (list: TreeNode<G, F>[], depth: number) => {
    list.sort((a, b) => compareSiblings(nodePosition(a), nodePosition(b)));
    for (const node of list) {
      node.depth = depth;
      if (node.kind === "group") walk(node.children, depth + 1);
    }
  };
  walk(tree.roots, 0);
  return tree;
}

export function findNode<G extends TreeGroup, F extends TreeField>(tree: Tree<G, F>, ref: SiblingRef): TreeNode<G, F> | undefined {
  return ref.kind === "group" ? tree.groups.get(ref.id) : tree.fields.get(ref.id);
}

export function childrenOf<G extends TreeGroup, F extends TreeField>(tree: Tree<G, F>, parentId: string | null): TreeNode<G, F>[] {
  return parentId === null ? tree.roots : (tree.groups.get(parentId)?.children ?? []);
}

/** Pre-order list of visible nodes; children of collapsed groups are left out. */
export function flattenTree<G extends TreeGroup, F extends TreeField>(
  tree: Tree<G, F>,
  collapsed: ReadonlySet<string> = new Set(),
): TreeNode<G, F>[] {
  const out: TreeNode<G, F>[] = [];
  const walk = (list: TreeNode<G, F>[]) => {
    for (const node of list) {
      out.push(node);
      if (node.kind === "group" && !collapsed.has(node.id)) walk(node.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** The group `parentId` and every group above it, nearest first. */
export function ancestorsFrom<G extends TreeGroup, F extends TreeField>(tree: Tree<G, F>, parentId: string | null): GroupNode<G, F>[] {
  const out: GroupNode<G, F>[] = [];
  let node = parentId === null ? undefined : tree.groups.get(parentId);
  while (node) {
    out.push(node);
    node = node.parentId === null ? undefined : tree.groups.get(node.parentId);
  }
  return out;
}

/** Source labels from the top header down to the node itself, e.g. ["RDT Test", "Positive", "A"]. */
export function headerPath(tree: Tree, ref: SiblingRef): string[] {
  const node = findNode(tree, ref);
  if (!node) return [];
  const own = node.kind === "group" ? node.group.labelSource : node.field.labelSource;
  return [
    ...ancestorsFrom(tree, node.parentId)
      .reverse()
      .map((g) => g.group.labelSource),
    own,
  ];
}

export function formatPath(labels: string[]): string {
  return labels.join(" › ");
}

/** Levels of groups in this subtree, counting the group itself (a group with no sub-groups is 1). */
export function subtreeHeight(node: GroupNode): number {
  let height = 1;
  for (const child of node.children) {
    if (child.kind === "group") height = Math.max(height, 1 + subtreeHeight(child));
  }
  return height;
}

/** True when `candidateId` is `groupId` or sits somewhere inside it. */
export function isSameOrDescendant(tree: Tree, groupId: string, candidateId: string | null): boolean {
  return ancestorsFrom(tree, candidateId).some((g) => g.id === groupId);
}

export function descendants<G extends TreeGroup, F extends TreeField>(node: GroupNode<G, F>): TreeNode<G, F>[] {
  const out: TreeNode<G, F>[] = [];
  const walk = (list: TreeNode<G, F>[]) => {
    for (const child of list) {
      out.push(child);
      if (child.kind === "group") walk(child.children);
    }
  };
  walk(node.children);
  return out;
}

/**
 * Why a group (existing: `groupId`; new: null) can't sit under `parentId`, or null if it can.
 * Refuses cycles and nesting past MAX_GROUP_DEPTH, counting the group's own sub-groups.
 */
export function groupPlacementProblem(tree: Tree, groupId: string | null, parentId: string | null): string | null {
  if (groupId !== null && parentId !== null && isSameOrDescendant(tree, groupId, parentId)) {
    return "A group can't go inside itself or one of its own sub-groups.";
  }
  if (parentId !== null && !tree.groups.has(parentId)) return "That group was deleted. Reload and try again.";
  const node = groupId === null ? undefined : tree.groups.get(groupId);
  const height = node ? subtreeHeight(node) : 1;
  const parentLevels = parentId === null ? 0 : (tree.groups.get(parentId)?.depth ?? 0) + 1;
  if (parentLevels + height > MAX_GROUP_DEPTH) {
    return height > 1
      ? `Headers can nest up to ${MAX_GROUP_DEPTH} levels. This group has ${height} levels of its own, so it would reach ${parentLevels + height}.`
      : `Headers can nest up to ${MAX_GROUP_DEPTH} levels, and this would be level ${parentLevels + height}.`;
  }
  return null;
}

const SELECTION_NAMES: Record<Exclude<GroupSelection, "NONE">, string> = { ONE_OF: "One of", ANY_OF: "Any of" };

/** A selection group's options: descendant mark fields the AI reads or you type (Skip fields aren't options). */
export function selectionOptions<G extends TreeGroup, F extends TreeField>(node: GroupNode<G, F>): F[] {
  return descendants(node).flatMap((n) => (n.kind === "field" && n.field.dataType === "MARK" && n.field.mode !== "SKIP" ? [n.field] : []));
}

/** `parentId` itself or the nearest group above it with a selection. */
export function nearestSelectionGroup<G extends TreeGroup, F extends TreeField>(
  tree: Tree<G, F>,
  parentId: string | null,
): GroupNode<G, F> | undefined {
  return ancestorsFrom(tree, parentId).find((g) => g.group.selection !== "NONE");
}

type SelectionRule = "nesting" | "nonMark" | "options";

/** The first thing wrong with a selection group and the rule it breaks; null when fine or not a selection group. */
function selectionIssue(tree: Tree, groupId: string): { rule: SelectionRule; message: string } | null {
  const node = tree.groups.get(groupId);
  if (!node || node.group.selection === "NONE") return null;
  const name = `“${node.group.labelSource}”`;
  const kind = `“${SELECTION_NAMES[node.group.selection]}”`;

  const outer = nearestSelectionGroup(tree, node.parentId);
  if (outer) {
    return {
      rule: "nesting",
      message: `${name} is inside “${outer.group.labelSource}”, which is already a selection group. Selection groups can't be inside each other.`,
    };
  }
  const inside = descendants(node);
  const inner = inside.find((n) => n.kind === "group" && n.group.selection !== "NONE");
  if (inner && inner.kind === "group") {
    return {
      rule: "nesting",
      message: `“${inner.group.labelSource}” inside ${name} is already a selection group. Selection groups can't be inside each other.`,
    };
  }
  const nonMark = inside.find((n) => n.kind === "field" && n.field.dataType !== "MARK");
  if (nonMark && nonMark.kind === "field") {
    return {
      rule: "nonMark",
      message: `“${nonMark.field.labelSource}” has the type ${FIELD_TYPE_LABELS[nonMark.field.dataType]}. A ${kind} group can only contain Mark / tick fields.`,
    };
  }
  const options = selectionOptions(node).length;
  if (options < 2) {
    return {
      rule: "options",
      message: `A ${kind} group needs at least 2 Mark / tick fields set to Extract or Manual. ${name} has ${options}.`,
    };
  }
  return null;
}

/** What's wrong with a selection group, in plain language; null when fine or not a selection group. */
export function selectionProblem(tree: Tree, groupId: string): string | null {
  return selectionIssue(tree, groupId)?.message ?? null;
}

/** Selection groups whose rules a change to `ref` can affect: the nearest one above it, and any it contains. */
export function selectionGroupsAround(tree: Tree, ref: SiblingRef): string[] {
  const node = findNode(tree, ref);
  if (!node) return [];
  const ids: string[] = [];
  const nearest = nearestSelectionGroup(tree, node.parentId);
  if (nearest) ids.push(nearest.id);
  if (node.kind === "group") {
    if (node.group.selection !== "NONE") ids.push(node.id);
    for (const d of descendants(node)) if (d.kind === "group" && d.group.selection !== "NONE") ids.push(d.id);
  }
  return ids;
}

/**
 * The selection problem a change would leave, comparing the tree before and after it. Nesting and
 * non-mark problems are always refused. Too few options is refused only when the group had no
 * problem before: a group already left with one option by a field delete can still be renamed
 * (the group panel shows the problem), but it still can't take a non-mark field.
 */
export function introducedSelectionProblem(before: Tree, after: Tree, ref: SiblingRef): string | null {
  const ids = new Set([...selectionGroupsAround(before, ref), ...selectionGroupsAround(after, ref)]);
  for (const id of ids) {
    const issue = selectionIssue(after, id);
    if (!issue) continue;
    if (issue.rule !== "options" || selectionIssue(before, id) === null) return issue.message;
  }
  return null;
}

/** Why moving `ref` under `parentId` would be refused (depth, cycle or selection rules), or null. Mirrors the server. */
export function moveProblem<G extends TreeGroup, F extends TreeField>(
  tree: Tree<G, F>,
  groups: G[],
  fields: F[],
  ref: SiblingRef,
  parentId: string | null,
): string | null {
  if (ref.kind === "group") {
    const placement = groupPlacementProblem(tree, ref.id, parentId);
    if (placement) return placement;
    const moved = groups.map((g) => (g.id === ref.id ? { ...g, parentGroupId: parentId } : g));
    return introducedSelectionProblem(tree, buildTree(moved, fields), ref);
  }
  const moved = fields.map((f) => (f.id === ref.id ? { ...f, groupId: parentId } : f));
  return introducedSelectionProblem(tree, buildTree(groups, moved), ref);
}

/** `parentId`, or the nearest group above it that can take a new sub-group without passing MAX_GROUP_DEPTH. */
export function nearestGroupParent(tree: Tree, parentId: string | null): string | null {
  let p = parentId !== null && tree.groups.has(parentId) ? parentId : null;
  while (p !== null && groupPlacementProblem(tree, null, p) !== null) p = tree.groups.get(p)?.parentId ?? null;
  return p;
}

function keyAt(keys: string[], i: number): string {
  const key = keys[i];
  if (key === undefined) throw new Error(`Missing generated key ${i} of ${keys.length}`);
  return key;
}

export type ParentWrite = Sibling & { parentId: string | null };

export type GroupDeletePlan = {
  /** Rows to update before the group row is deleted. */
  writes: ParentWrite[];
  movedFields: number;
  movedGroups: number;
  parentId: string | null;
};

/**
 * Deleting a group never deletes or orphans a field (invariant 12). Its child groups and live
 * fields move up one level into the group's slot, in order. (Its soft-deleted fields are
 * re-parented to `parentId` by the caller, keeping their keys, so a restore lands on the nearest
 * surviving ancestor.)
 */
export function planGroupDelete(tree: Tree, groupId: string): GroupDeletePlan | null {
  const node = tree.groups.get(groupId);
  if (!node) return null;
  const { parentId } = node;
  const siblings = childrenOf(tree, parentId);
  const at = siblings.indexOf(node);
  const before = siblings.slice(0, at);
  const after = siblings.slice(at + 1);
  const moving = node.children;
  const writes: ParentWrite[] = [];

  if (moving.length > 0) {
    const low = node.group.position;
    const next = after[0];
    const high = next ? nodePosition(next).position : null;
    if (high === null || low < high) {
      const keys = generateNKeysBetween(low, high, moving.length);
      moving.forEach((child, i) => writes.push({ kind: child.kind, id: child.id, parentId, position: keyAt(keys, i) }));
    } else {
      // Equal neighbouring keys leave no room between them: re-space the whole new sibling list.
      const order = [...before, ...moving, ...after];
      const keys = generateNKeysBetween(null, null, order.length);
      order.forEach((child, i) => writes.push({ kind: child.kind, id: child.id, parentId, position: keyAt(keys, i) }));
    }
  }
  return {
    writes,
    movedFields: moving.filter((c) => c.kind === "field").length,
    movedGroups: moving.filter((c) => c.kind === "group").length,
    parentId,
  };
}

/** Key for an optimistic client-side move, or null when only the server can decide (e.g. equal neighbour keys). */
export function localPositionAfter(siblings: Sibling[], after: SiblingRef | null, moving: SiblingRef): string | null {
  const list = siblings.filter((s) => !sameRef(s, moving)).sort(compareSiblings);
  const at = after === null ? 0 : list.findIndex((s) => sameRef(s, after)) + 1;
  if (after !== null && at === 0) return null;
  try {
    return generateKeyBetween(list[at - 1]?.position ?? null, list[at]?.position ?? null);
  } catch {
    return null;
  }
}
