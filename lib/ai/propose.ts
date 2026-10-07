import { MAX_PROPOSED_FIELDS } from "@/lib/templates/field-proposal-schemas";
import { FIELD_TYPES, MAX_CHOICES, type FieldType } from "@/lib/templates/schemas";

import { outputLimitError, type ModelCall, type ModelPrompt } from "./extract";
import { buildFieldProposalPrompt, buildFieldProposalRepair } from "./prompts";
import { addUsage, emptyUsage, ProviderError, type FieldProposalRequest, type FieldProposalResult, type ProposedFieldDTO, type ResponseLog } from "./provider";
import type { JsonSchema } from "./response-schema";
import { withProviderRetry } from "./retry";

/**
 * The template proposal loop (Phase 16), shared by every provider: the same shape as extraction's
 * `extractWithRepair` — call, validate, ask once more with the problems listed, then fail keeping every
 * response — over a fixed schema. The extraction loop is left untouched on purpose: it is the path
 * that writes data.
 */

/**
 * The most one ask for a field list may write, thinking included (Phase 23). Nothing else bounds
 * thinking on these models: on 2026-10-06 one ask thought for 62,910 tokens and cost $0.58 where a
 * good one costs $0.05, with a worse list. An ask that reaches this fails, costs the operator nothing
 * and costs the deployment at most this much (about $0.22 on 3.5 Flash). Sharp pages wrote 5,000 to
 * 5,700; 12,000 was tried first and cut off two readings of a blurry page, so this is twice that.
 */
export const PROPOSAL_MAX_OUTPUT_TOKENS = 24_000;

const LABEL_MAX = 500;
const NOTE_MAX = 2000;
const CHOICE_MAX = 200;

const nullableString = { type: ["string", "null"] };

export const FIELD_PROPOSAL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          labelSource: { type: "string" },
          labelMeaning: nullableString,
          dataType: { type: "string", enum: [...FIELD_TYPES] },
          choices: { type: "array", items: { type: "string" } },
          note: nullableString,
        },
        required: ["labelSource", "labelMeaning", "dataType", "choices", "note"],
      },
    },
  },
  required: ["fields"],
};

/** Trimmed text, null when blank. Too long for the column is also null: never a silently shortened value. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || t.length > max ? null : t;
}

/**
 * Structural problems are sent back to the model; small ones are tidied here instead, because asking
 * again costs money for something the operator will see and correct anyway. An item with a blank or
 * over-long label is dropped — the first is not a field, the second is the model listing row data as a
 * label — as are over-long meanings, notes and choices; duplicate choices are dropped, a CHOICE without
 * choices becomes TEXT, and choices on any other type are dropped. Labels are never rewritten beyond
 * trimming: the label is what the operator checks against the paper.
 */
export function validateFieldProposal(json: unknown): { ok: true; fields: ProposedFieldDTO[] } | { ok: false; issues: string[] } {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { fields?: unknown }).fields)) {
    return { ok: false, issues: ['The response must be an object with a "fields" array.'] };
  }
  const items = (json as { fields: unknown[] }).fields;
  if (items.length > MAX_PROPOSED_FIELDS) {
    return { ok: false, issues: [`List at most ${MAX_PROPOSED_FIELDS} fields. Row values are not fields.`] };
  }
  const issues: string[] = [];
  const fields: ProposedFieldDTO[] = [];
  items.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      issues.push(`fields[${i}] is not an object.`);
      return;
    }
    const f = item as Record<string, unknown>;
    const labelSource = text(f.labelSource, LABEL_MAX);
    if (labelSource === null) return;
    if (typeof f.dataType !== "string" || !(FIELD_TYPES as readonly string[]).includes(f.dataType)) {
      issues.push(`fields[${i}].dataType must be one of ${FIELD_TYPES.join(", ")}.`);
      return;
    }
    const raw = Array.isArray(f.choices) ? f.choices : [];
    const choices = [...new Set(raw.map((c) => text(c, CHOICE_MAX)).filter((c): c is string => c !== null))].slice(0, MAX_CHOICES);
    let dataType = f.dataType as FieldType;
    if (dataType === "CHOICE" && choices.length === 0) dataType = "TEXT";
    fields.push({
      labelSource,
      labelMeaning: text(f.labelMeaning, LABEL_MAX),
      dataType,
      choices: dataType === "CHOICE" ? choices : [],
      note: text(f.note, NOTE_MAX),
    });
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, fields };
}

export async function proposeWithRepair(call: ModelCall, req: FieldProposalRequest): Promise<FieldProposalResult> {
  const prompt = buildFieldProposalPrompt(req);
  const usage = emptyUsage();
  const responses: ResponseLog[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = responses.at(-1);
    const current: ModelPrompt = previous
      ? { system: prompt.system, parts: [...prompt.parts, { kind: "text", text: buildFieldProposalRepair(previous.text, previous.issues) }] }
      : prompt;
    let res;
    try {
      res = await withProviderRetry(() => call(current, FIELD_PROPOSAL_SCHEMA, req.model, { maxOutputTokens: PROPOSAL_MAX_OUTPUT_TOKENS }));
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ProviderError(err.kind, err.message, { usage, rawResponse: { responses } });
      }
      throw err;
    }
    addUsage(usage, res.usage);
    if (res.truncated) throw outputLimitError(usage, responses, attempt, res.text);

    let json: unknown;
    try {
      json = JSON.parse(res.text ?? "");
    } catch {
      responses.push({ attempt, text: res.text, issues: ["The response is not valid JSON."] });
      continue;
    }
    const outcome = validateFieldProposal(json);
    if (outcome.ok) {
      responses.push({ attempt, text: res.text, issues: [] });
      return { fields: outcome.fields, usage, rawResponse: { responses } };
    }
    responses.push({ attempt, text: res.text, issues: outcome.issues });
  }
  throw new ProviderError("INVALID_RESPONSE", "The response did not match the field list schema.", { usage, rawResponse: { responses } });
}
