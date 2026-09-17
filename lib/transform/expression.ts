import jsep from "jsep";

import {
  addDecimal,
  ceilDecimal,
  compareDecimal,
  divDecimal,
  floorDecimal,
  formatDecimal,
  isZeroDecimal,
  mulDecimal,
  parseDecimal,
  roundDecimal,
  subDecimal,
  type Decimal,
} from "./decimal";
import { numericReading, parseNumberText } from "./numerals";

/**
 * The EXPRESSION mapping language (docs/03 §9). Parsed with jsep, checked against an allow-list and
 * evaluated by a hand-written walker: no eval, no property access, no loops. Field and group references
 * are written `{id}`. Validated when a mapping is saved; evaluation is bounded by a step budget.
 */

jsep.addBinaryOp("and", 2);
jsep.addBinaryOp("or", 1);
jsep.addUnaryOp("not");

export const MAX_EXPRESSION_LENGTH = 2000;
const MAX_NODES = 500;
const MAX_STEPS = 10_000;
const MAX_TEXT = 10_000;
const REF = "__ref";

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  concat: { min: 1, max: 50 },
  substring: { min: 2, max: 3 },
  replace: { min: 3, max: 3 },
  trim: { min: 1, max: 1 },
  upper: { min: 1, max: 1 },
  lower: { min: 1, max: 1 },
  if: { min: 3, max: 3 },
  number: { min: 1, max: 1 },
  text: { min: 1, max: 1 },
  default: { min: 2, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  round: { min: 1, max: 1 },
};

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);

const BINARY = new Set(["+", "-", "*", "/", "==", "!=", "<", "<=", ">", ">=", "and", "or", "&&", "||"]);
const UNARY = new Set(["-", "+", "not", "!"]);

export type ParsedExpression = { ast: jsep.Expression; refs: string[] };

type Scan = { text: string; refs: string[] } | { problem: string };

/** Calls `onRef` for each `{…}` outside string literals and splices in what it returns. */
function scanBraces(source: string, onRef: (inner: string) => string | { problem: string }): Scan {
  let out = "";
  const refs: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "{") {
      const close = source.indexOf("}", i + 1);
      if (close < 0) return { problem: "A “{” has no matching “}”." };
      const replaced = onRef(source.slice(i + 1, close));
      if (typeof replaced !== "string") return replaced;
      out += replaced;
      i = close;
      continue;
    }
    out += ch;
  }
  return { text: out, refs };
}

function substituteRefs(source: string): Scan {
  const refs: string[] = [];
  const scan = scanBraces(source, (inner) => {
    const id = inner.trim();
    if (!/^[a-z0-9]{1,64}$/u.test(id)) return { problem: `“{${inner}}” isn't a field this expression can use. Insert fields with the picker.` };
    let index = refs.indexOf(id);
    if (index < 0) index = refs.push(id) - 1;
    return `${REF}${index}`;
  });
  return "problem" in scan ? scan : { text: scan.text, refs };
}

function nodeProblem(node: jsep.Expression, refs: string[], budget: { nodes: number }): string | null {
  if (++budget.nodes > MAX_NODES) return "The expression is too long. Split the work across columns.";
  switch (node.type) {
    case "Literal": {
      const v = (node as jsep.Literal).value;
      return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? null : "That value isn't allowed.";
    }
    case "Identifier": {
      const name = (node as jsep.Identifier).name;
      const m = new RegExp(`^${REF}(\\d+)$`, "u").exec(name);
      if (m && Number(m[1]) < refs.length) return null;
      return `“${name}” isn't a field or a function. Insert fields with the picker, and put text in quotes.`;
    }
    case "BinaryExpression": {
      const b = node as jsep.BinaryExpression;
      if (!BINARY.has(b.operator)) return `The operator “${b.operator}” isn't allowed.`;
      return nodeProblem(b.left, refs, budget) ?? nodeProblem(b.right, refs, budget);
    }
    case "UnaryExpression": {
      const u = node as jsep.UnaryExpression;
      if (!UNARY.has(u.operator)) return `The operator “${u.operator}” isn't allowed.`;
      return nodeProblem(u.argument, refs, budget);
    }
    case "CallExpression": {
      const c = node as jsep.CallExpression;
      if (c.callee.type !== "Identifier") return "Only the listed functions can be called.";
      const name = (c.callee as jsep.Identifier).name;
      const spec = FUNCTIONS[name];
      if (!spec) return `“${name}” isn't a function. Use one of: ${EXPRESSION_FUNCTIONS.join(", ")}.`;
      if (c.arguments.length < spec.min || c.arguments.length > spec.max) {
        const count = spec.min === spec.max ? `${spec.min}` : `${spec.min} to ${spec.max}`;
        return `${name}() takes ${count} values, not ${c.arguments.length}.`;
      }
      for (const arg of c.arguments) {
        const problem = nodeProblem(arg, refs, budget);
        if (problem) return problem;
      }
      return null;
    }
    case "MemberExpression":
      return "Property access such as a.b isn't allowed.";
    case "ConditionalExpression":
      return "Use if(condition, then, otherwise) instead of ? :.";
    case "Compound":
    case "SequenceExpression":
      return "Write a single expression.";
    default:
      return "That part of the expression isn't allowed.";
  }
}

/** Parses and checks an expression. `refs` are the field and group ids it reads, in first-use order. */
export function parseExpression(source: string): { ok: true; value: ParsedExpression } | { ok: false; problem: string } {
  if (source.trim() === "") return { ok: false, problem: "Write an expression." };
  if (source.length > MAX_EXPRESSION_LENGTH) return { ok: false, problem: `Keep expressions to ${MAX_EXPRESSION_LENGTH} characters or fewer.` };
  const scan = substituteRefs(source);
  if ("problem" in scan) return { ok: false, problem: scan.problem };
  let ast: jsep.Expression;
  try {
    ast = jsep(scan.text);
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(new RegExp(`${REF}\\d+`, "gu"), "field") : "unknown problem";
    return { ok: false, problem: `The expression can't be read: ${message}.` };
  }
  const problem = nodeProblem(ast, scan.refs, { nodes: 0 });
  return problem ? { ok: false, problem } : { ok: true, value: { ast, refs: scan.refs } };
}

// ---------- evaluation ----------

type Val = string | Decimal | boolean | null;

class EvalError extends Error {}

const isDecimal = (v: Val): v is Decimal => typeof v === "object" && v !== null;

function toText(v: Val): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return formatDecimal(v);
}

function numberFrom(v: Val): Decimal | null {
  if (isDecimal(v)) return v;
  if (typeof v === "boolean") throw new EvalError("A yes/no value can't be used as a number.");
  const t = toText(v).trim();
  if (t === "") return null;
  const parsed = parseNumberText(numericReading(t, "AUTO").text);
  const d = parsed === null ? null : parseDecimal(parsed);
  if (!d) throw new EvalError(`“${t}” isn't a number.`);
  return d;
}

function tryNumber(v: Val): Decimal | null {
  try {
    return numberFrom(v);
  } catch {
    return null;
  }
}

function truthy(v: Val): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v !== "";
  return !isZeroDecimal(v);
}

function smallInt(v: Val, what: string): number {
  const d = numberFrom(v);
  if (!d) throw new EvalError(`${what} is empty.`);
  const n = Number(formatDecimal(d));
  if (!Number.isInteger(n) || n < 0 || n > MAX_TEXT) throw new EvalError(`${what} must be a whole number from 0 to ${MAX_TEXT}.`);
  return n;
}

function capped(text: string): string {
  if (text.length > MAX_TEXT) throw new EvalError("The result is too long.");
  return text;
}

/**
 * Evaluates a checked expression. `lookup` returns the value of a referenced field or group (null
 * when empty). The result is text, or null when empty; a failure is returned as `error`.
 */
export function evaluateExpression(
  parsed: ParsedExpression,
  lookup: (id: string) => string | null,
): { value: string | null } | { error: string } {
  let steps = 0;
  const walk = (node: jsep.Expression): Val => {
    if (++steps > MAX_STEPS) throw new EvalError("The expression took too long.");
    switch (node.type) {
      case "Literal": {
        const lit = node as jsep.Literal;
        if (typeof lit.value === "number") {
          const d = parseDecimal(lit.raw);
          if (!d) throw new EvalError(`“${lit.raw}” isn't a number.`);
          return d;
        }
        return typeof lit.value === "string" || typeof lit.value === "boolean" ? lit.value : null;
      }
      case "Identifier": {
        const index = Number((node as jsep.Identifier).name.slice(REF.length));
        const id = parsed.refs[index];
        return id === undefined ? null : lookup(id);
      }
      case "UnaryExpression": {
        const u = node as jsep.UnaryExpression;
        const arg = walk(u.argument);
        if (u.operator === "not" || u.operator === "!") return !truthy(arg);
        const d = numberFrom(arg);
        if (!d) return null;
        return u.operator === "-" ? subDecimal({ units: BigInt(0), scale: 0 }, d) : d;
      }
      case "BinaryExpression": {
        const b = node as jsep.BinaryExpression;
        if (b.operator === "and" || b.operator === "&&") return truthy(walk(b.left)) && truthy(walk(b.right));
        if (b.operator === "or" || b.operator === "||") return truthy(walk(b.left)) || truthy(walk(b.right));
        const left = walk(b.left);
        const right = walk(b.right);
        switch (b.operator) {
          case "+":
            // Numbers add only when both sides are numbers (literals or number()); field text concatenates.
            if (isDecimal(left) && isDecimal(right)) return addDecimal(left, right);
            if (left === null && right === null) return null;
            return capped(toText(left) + toText(right));
          case "-":
          case "*":
          case "/": {
            const x = numberFrom(left);
            const y = numberFrom(right);
            if (!x || !y) return null;
            if (b.operator === "-") return subDecimal(x, y);
            if (b.operator === "*") return mulDecimal(x, y);
            const q = divDecimal(x, y);
            if (!q) throw new EvalError("Division by zero.");
            return q;
          }
          case "==":
          case "!=": {
            const x = tryNumber(left);
            const y = tryNumber(right);
            const equal = (isDecimal(left) || isDecimal(right)) && x && y ? compareDecimal(x, y) === 0 : toText(left) === toText(right);
            return b.operator === "==" ? equal : !equal;
          }
          default: {
            const x = tryNumber(left);
            const y = tryNumber(right);
            const cmp = x && y ? compareDecimal(x, y) : toText(left) < toText(right) ? -1 : toText(left) > toText(right) ? 1 : 0;
            if (b.operator === "<") return cmp < 0;
            if (b.operator === "<=") return cmp <= 0;
            if (b.operator === ">") return cmp > 0;
            return cmp >= 0;
          }
        }
      }
      case "CallExpression": {
        const c = node as jsep.CallExpression;
        const name = (c.callee as jsep.Identifier).name;
        const arg = (i: number): Val => {
          const a = c.arguments[i];
          return a === undefined ? null : walk(a);
        };
        switch (name) {
          case "if":
            return truthy(arg(0)) ? arg(1) : arg(2);
          case "concat":
            return capped(c.arguments.map((a) => toText(walk(a))).join(""));
          case "substring": {
            const chars = Array.from(toText(arg(0)));
            const start = smallInt(arg(1), "The start");
            const length = c.arguments.length > 2 ? smallInt(arg(2), "The length") : chars.length;
            return chars.slice(start, start + length).join("");
          }
          case "replace": {
            const s = toText(arg(0));
            const find = toText(arg(1));
            return find === "" ? s : capped(s.split(find).join(toText(arg(2))));
          }
          case "trim":
            return toText(arg(0)).trim();
          case "upper":
            return toText(arg(0)).toUpperCase();
          case "lower":
            return toText(arg(0)).toLowerCase();
          case "number":
            return numberFrom(arg(0));
          case "floor":
          case "ceil":
          case "round": {
            const value = numberFrom(arg(0));
            if (!value) return null;
            return name === "floor" ? floorDecimal(value) : name === "ceil" ? ceilDecimal(value) : roundDecimal(value);
          }
          case "text":
            return toText(arg(0));
          case "default": {
            const first = arg(0);
            return toText(first) === "" ? arg(1) : first;
          }
          default:
            throw new EvalError(`“${name}” isn't a function.`);
        }
      }
      default:
        throw new EvalError("That part of the expression isn't allowed.");
    }
  };
  try {
    const text = toText(walk(parsed.ast));
    return { value: text === "" ? null : text };
  } catch (err) {
    if (err instanceof EvalError) return { error: err.message };
    throw err;
  }
}

// ---------- display ----------

/** `{id}` → `{Label}` where `labelFor` knows a unique label for the id; for showing expressions to people. */
export function expressionToDisplay(source: string, labelFor: (id: string) => string | null): string {
  const scan = scanBraces(source, (inner) => {
    const label = labelFor(inner.trim());
    return `{${label ?? inner}}`;
  });
  return "problem" in scan ? source : scan.text;
}

/** `{Label}` → `{id}` where `idFor` knows the label; unknown references are left for validation to report. */
export function expressionFromDisplay(text: string, idFor: (label: string) => string | null): string {
  const scan = scanBraces(text, (inner) => `{${idFor(inner.trim()) ?? inner}}`);
  return "problem" in scan ? text : scan.text;
}
