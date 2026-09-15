import { buildExtractionPrompt, buildRepairInstruction } from "./prompts";
import { ProviderError, type ExtractionRequest, type ExtractionResult, type ResponseLog } from "./provider";
import { extractionResponseSchema, type JsonSchema } from "./response-schema";
import { withProviderRetry } from "./retry";
import { validateExtraction } from "./validate";

/** A provider-neutral prompt: system text plus ordered text and image parts. */
export type ModelPrompt = {
  system: string;
  parts: ({ kind: "text"; text: string } | { kind: "image"; data: Buffer; mimeType: string })[];
};

export type ModelCall = (
  prompt: ModelPrompt,
  schema: JsonSchema,
  model: ExtractionRequest["model"],
) => Promise<{ text: string | null; usage: { inputTokens: number; outputTokens: number } }>;

/**
 * Shared extraction loop for every provider: build the prompt and schema, call the model (with
 * retries on rate limits and outages), validate, and ask once more with the problems listed if the
 * answer doesn't fit (docs/03 §2). A second bad answer fails with every response kept for debugging.
 */
export async function extractWithRepair(call: ModelCall, req: ExtractionRequest): Promise<ExtractionResult> {
  const pageIndexes = req.images.map((i) => i.pageIndex);
  const schema = extractionResponseSchema(req.template, pageIndexes);
  const prompt = buildExtractionPrompt(req);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const responses: ResponseLog[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = responses.at(-1);
    const current: ModelPrompt = previous
      ? { system: prompt.system, parts: [...prompt.parts, { kind: "text", text: buildRepairInstruction(previous.text, previous.issues) }] }
      : prompt;
    let res;
    try {
      res = await withProviderRetry(() => call(current, schema, req.model));
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ProviderError(err.kind, err.message, { usage, rawResponse: { responses } });
      }
      throw err;
    }
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;

    let json: unknown;
    try {
      json = JSON.parse(res.text ?? "");
    } catch {
      responses.push({ attempt, text: res.text, issues: ["The response is not valid JSON."] });
      continue;
    }
    const outcome = validateExtraction(json, req.template, pageIndexes);
    if (outcome.ok) {
      responses.push({ attempt, text: res.text, issues: [] });
      return { ...outcome.value, usage, rawResponse: { responses } };
    }
    responses.push({ attempt, text: res.text, issues: outcome.issues });
  }
  throw new ProviderError("INVALID_RESPONSE", "The response did not match the template schema.", { usage, rawResponse: { responses } });
}
