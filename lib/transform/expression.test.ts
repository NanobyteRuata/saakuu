import { describe, expect, it } from "vitest";

import { evaluateExpression, expressionFromDisplay, expressionToDisplay, parseExpression } from "./expression";

/** The expression language decides cell values, so its safety and exactness are tested (docs/03 §9). */

function run(source: string, values: Record<string, string | null>) {
  const parsed = parseExpression(source);
  if (!parsed.ok) throw new Error(parsed.problem);
  return evaluateExpression(parsed.value, (id) => values[id] ?? null);
}

describe("expressions", () => {
  it("refuses anything outside the allow-list at save time", () => {
    for (const source of ["a.b", "{abc}.constructor", "x ? 1 : 2", "eval('1')", "this", "[1, 2]", "1; 2", "{abc} % 2"]) {
      expect(parseExpression(source).ok, source).toBe(false);
    }
  });

  it("computes exactly, without floats", () => {
    expect(run("number({w}) * 2.2", { w: "12.5" })).toEqual({ value: "27.5" });
    expect(run("0.1 + 0.2", {})).toEqual({ value: "0.3" });
    expect(run("number({n}) + 1", { n: "၁၂" })).toEqual({ value: "13" });
  });

  it("rounds to whole numbers exactly, including negatives and empty values", () => {
    expect(run("floor(number({a}) / 12)", { a: "18" })).toEqual({ value: "1" });
    expect(run("floor(-1.5)", {})).toEqual({ value: "-2" });
    expect(run("ceil(-1.2)", {})).toEqual({ value: "-1" });
    expect(run("ceil(1.2)", {})).toEqual({ value: "2" });
    expect(run("round(2.5)", {})).toEqual({ value: "3" });
    expect(run("round(-2.5)", {})).toEqual({ value: "-3" });
    expect(run("round(2.49)", {})).toEqual({ value: "2" });
    expect(run("floor(number({a}))", { a: null })).toEqual({ value: null });
  });

  it("joins field text with + and reports failures instead of guessing", () => {
    expect(run("{a} + {b}", { a: "1", b: "2" })).toEqual({ value: "12" });
    expect(run("if({s} == \"M\" and not ({t} == \"\"), \"male\", default({t}, \"?\"))", { s: "F", t: null })).toEqual({ value: "?" });
    expect(run("number({a}) / 0", { a: "1" })).toEqual({ error: "Division by zero." });
    expect(run("number({a})", { a: "abc" })).toEqual({ error: "“abc” isn't a number." });
  });

  it("round-trips references between ids and labels, leaving string literals alone", () => {
    const labels: Record<string, string> = { abc: "Age", def: "Name" };
    const ids = Object.fromEntries(Object.entries(labels).map(([id, label]) => [label, id]));
    const shown = expressionToDisplay('concat({def}, "{abc}", {abc})', (id) => labels[id] ?? null);
    expect(shown).toBe('concat({Name}, "{abc}", {Age})');
    expect(expressionFromDisplay(shown, (label) => ids[label] ?? null)).toBe('concat({def}, "{abc}", {abc})');
  });
});
