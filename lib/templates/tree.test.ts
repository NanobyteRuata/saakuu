import { describe, expect, it } from "vitest";

import type { FieldMode, FieldType, GroupSelection } from "./schemas";
import {
  buildTree,
  flattenTree,
  groupPlacementProblem,
  headerPath,
  introducedSelectionProblem,
  planGroupDelete,
  selectionProblem,
  type TreeField,
  type TreeGroup,
} from "./tree";

function group(id: string, labelSource: string, parentGroupId: string | null, position: string, selection: GroupSelection = "NONE"): TreeGroup {
  return { id, labelSource, labelMeaning: null, parentGroupId, position, selection };
}

function field(id: string, labelSource: string, groupId: string | null, position: string, dataType: FieldType = "MARK", mode: FieldMode = "EXTRACT"): TreeField {
  return { id, labelSource, labelMeaning: null, groupId, position, dataType, mode };
}

// | No. | Name | Sex (M F) | Age | RDT Test (Positive (A B C), Neg.) | Remarks |
function register() {
  const groups = [
    group("g_sex", "Sex", null, "a2", "ONE_OF"),
    group("g_rdt", "RDT Test", null, "a4", "ONE_OF"),
    group("g_pos", "Positive", "g_rdt", "a0"),
  ];
  const fields = [
    field("f_no", "No.", null, "a0", "INTEGER"),
    field("f_name", "Name", null, "a1", "TEXT", "MANUAL"),
    field("f_m", "M", "g_sex", "a0"),
    field("f_f", "F", "g_sex", "a1"),
    field("f_age", "Age", null, "a3", "AGE"),
    field("f_a", "A", "g_pos", "a0"),
    field("f_b", "B", "g_pos", "a1"),
    field("f_c", "C", "g_pos", "a2"),
    field("f_neg", "Neg.", "g_rdt", "a1"),
    field("f_remarks", "Remarks", null, "a5", "TEXT", "SKIP"),
  ];
  return { groups, fields };
}

const labels = (groups: TreeGroup[], fields: TreeField[]) =>
  flattenTree(buildTree(groups, fields)).map((n) => `${"  ".repeat(n.depth)}${n.kind === "group" ? n.group.labelSource : n.field.labelSource}`);

/** Applies a delete plan the way the service does: move children, re-parent, drop the group row. */
function applyDelete(groups: TreeGroup[], fields: TreeField[], groupId: string) {
  const plan = planGroupDelete(buildTree(groups, fields), groupId);
  if (!plan) throw new Error("no plan");
  const nextGroups = groups
    .filter((g) => g.id !== groupId)
    .map((g) => {
      const w = plan.writes.find((x) => x.kind === "group" && x.id === g.id);
      return w ? { ...g, parentGroupId: w.parentId, position: w.position } : g;
    });
  const nextFields = fields.map((f) => {
    const w = plan.writes.find((x) => x.kind === "field" && x.id === f.id);
    return w ? { ...f, groupId: w.parentId, position: w.position } : f;
  });
  return { plan, groups: nextGroups, fields: nextFields };
}

describe("source tree", () => {
  it("interleaves groups and fields in paper order and builds header paths", () => {
    const { groups, fields } = register();
    expect(labels(groups, fields)).toEqual([
      "No.",
      "Name",
      "Sex",
      "  M",
      "  F",
      "Age",
      "RDT Test",
      "  Positive",
      "    A",
      "    B",
      "    C",
      "  Neg.",
      "Remarks",
    ]);
    expect(headerPath(buildTree(groups, fields), { kind: "field", id: "f_a" })).toEqual(["RDT Test", "Positive", "A"]);
  });
});

describe("group delete re-parenting", () => {
  it("moves RDT Test's sub-group and field up into its slot, in order, losing no field", () => {
    const { groups, fields } = register();
    const after = applyDelete(groups, fields, "g_rdt");

    expect(after.plan).toMatchObject({ movedFields: 1, movedGroups: 1, parentId: null });
    expect(labels(after.groups, after.fields)).toEqual([
      "No.",
      "Name",
      "Sex",
      "  M",
      "  F",
      "Age",
      "Positive",
      "  A",
      "  B",
      "  C",
      "Neg.",
      "Remarks",
    ]);
    const tree = buildTree(after.groups, after.fields);
    expect(tree.fields.size).toBe(fields.length);
    // Every field hangs off a live group or the top level: nothing orphaned.
    for (const f of after.fields) expect(f.groupId === null || tree.groups.has(f.groupId)).toBe(true);
    // Only the moved children are written; siblings keep their keys.
    expect(after.plan.writes.map((w) => w.id)).toEqual(["g_pos", "f_neg"]);
  });

  it("moves a nested group's fields into its parent before the next sibling", () => {
    const { groups, fields } = register();
    const after = applyDelete(groups, fields, "g_pos");
    expect(after.plan).toMatchObject({ movedFields: 3, movedGroups: 0, parentId: "g_rdt" });
    expect(labels(after.groups, after.fields).slice(6)).toEqual(["RDT Test", "  A", "  B", "  C", "  Neg.", "Remarks"]);
  });

  it("re-spaces the parent's children when the group's key collides with the next sibling", () => {
    const { groups, fields } = register();
    // Remarks gets RDT Test's exact key and sorts after it by id, leaving no room between them.
    const colliding = fields.map((f) => (f.id === "f_remarks" ? { ...f, id: "z_remarks", position: "a4" } : f));
    const after = applyDelete(groups, colliding, "g_rdt");
    expect(labels(after.groups, after.fields)).toEqual([
      "No.",
      "Name",
      "Sex",
      "  M",
      "  F",
      "Age",
      "Positive",
      "  A",
      "  B",
      "  C",
      "Neg.",
      "Remarks",
    ]);
    const tops = buildTree(after.groups, after.fields).roots.map((n) => (n.kind === "group" ? n.group.position : n.field.position));
    expect(new Set(tops).size).toBe(tops.length);
  });
});

describe("depth and cycle refusal", () => {
  const chain = () => [group("g1", "L1", null, "a0"), group("g2", "L2", "g1", "a0"), group("g3", "L3", "g2", "a0"), group("gx", "X", null, "a1")];

  it("refuses a 4th nesting level", () => {
    const tree = buildTree(chain(), []);
    expect(groupPlacementProblem(tree, null, "g3")).toMatch(/up to 3 levels/);
    expect(groupPlacementProblem(tree, null, "g2")).toBeNull();
  });

  it("counts the moved group's own sub-groups", () => {
    const groups = [...chain(), group("gy", "Y", "gx", "a0")];
    const tree = buildTree(groups, []);
    // gx has 2 levels; under g2 (level 2) it would reach level 4.
    expect(groupPlacementProblem(tree, "gx", "g2")).toMatch(/2 levels of its own/);
    expect(groupPlacementProblem(tree, "gx", "g1")).toBeNull();
  });

  it("refuses moving a group into itself or its own descendant", () => {
    const tree = buildTree(chain(), []);
    expect(groupPlacementProblem(tree, "g1", "g1")).toMatch(/inside itself/);
    expect(groupPlacementProblem(tree, "g1", "g3")).toMatch(/inside itself/);
    expect(groupPlacementProblem(tree, "g3", null)).toBeNull();
  });
});

describe("selection groups", () => {
  it("refuses a One of group holding a non-mark field", () => {
    const { groups, fields } = register();
    const before = buildTree(groups, fields);
    const withText = [...fields, field("f_x", "Other", "g_sex", "a2", "TEXT")];
    const after = buildTree(groups, withText);
    expect(selectionProblem(before, "g_sex")).toBeNull();
    expect(introducedSelectionProblem(before, after, { kind: "field", id: "f_x" })).toMatch(/“Other” has the type Text/);
  });

  it("still refuses a non-mark field in a group that already has too few options", () => {
    const { groups, fields } = register();
    const oneOption = fields.filter((f) => f.id !== "f_f");
    const before = buildTree(groups, oneOption);
    const after = buildTree(
      groups,
      oneOption.map((f) => (f.id === "f_age" ? { ...f, groupId: "g_sex" } : f)),
    );
    expect(introducedSelectionProblem(before, after, { kind: "field", id: "f_age" })).toMatch(/“Age” has the type Age/);
  });

  it("refuses fewer than 2 options and nested selection groups, but not unrelated edits to an existing problem", () => {
    const { groups, fields } = register();
    const oneOption = fields.map((f) => (f.id === "f_f" ? { ...f, mode: "SKIP" as const } : f));
    expect(selectionProblem(buildTree(groups, oneOption), "g_sex")).toMatch(/at least 2/);

    const nested = groups.map((g) => (g.id === "g_pos" ? { ...g, selection: "ANY_OF" as const } : g));
    expect(introducedSelectionProblem(buildTree(groups, fields), buildTree(nested, fields), { kind: "group", id: "g_pos" })).toMatch(
      /can't be inside each other/,
    );

    const renamed = groups.map((g) => (g.id === "g_sex" ? { ...g, labelSource: "Gender" } : g));
    expect(introducedSelectionProblem(buildTree(groups, oneOption), buildTree(renamed, oneOption), { kind: "group", id: "g_sex" })).toBeNull();
  });
});
