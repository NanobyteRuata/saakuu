import { ApiError, FinishReason, GoogleGenAI, MediaModality, ThinkingLevel, type Part } from "@google/genai";

import { extractWithRepair, type ModelCall } from "./extract";
import { AI_MODELS } from "./models";
import { proposeWithRepair } from "./propose";
import { ProviderError, type AIProvider, type ThinkingEffort } from "./provider";

/**
 * Gemini implementation of `AIProvider`. Gemini types stay inside this file. Structured output uses
 * `responseJsonSchema` with the provider-neutral JSON schema, so nothing is converted.
 */

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ApiError) {
    // A day's quota is a 429 like a per-minute limit, but no retry outlasts it: retrying only keeps the
    // operator waiting for an answer that was known at once.
    if (err.status === 429) return new ProviderError(/PerDay/i.test(err.message) ? "QUOTA_EXHAUSTED" : "RATE_LIMITED", firstSentence(err.message));
    if (err.status >= 500) return new ProviderError("UNAVAILABLE", err.message);
    if (err.status === 401 || err.status === 403) return new ProviderError("KEY_REFUSED", err.message);
    return new ProviderError("BAD_REQUEST", firstSentence(err.message));
  }
  // fetch failures, timeouts, resets
  return new ProviderError("UNAVAILABLE", err instanceof Error ? err.message : String(err));
}

function firstSentence(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const THINKING: Record<Exclude<ThinkingEffort, "default">, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};
/** Models whose lowest level is low: asked for minimal, they get low rather than a refused request. */
const NO_MINIMAL_THINKING = new Set(["gemini-3.7-flash"]);

function thinkingLevel(effort: ThinkingEffort, model: string): ThinkingLevel | null {
  if (effort === "default") return null;
  return effort === "minimal" && NO_MINIMAL_THINKING.has(model) ? ThinkingLevel.LOW : THINKING[effort];
}

export function createGeminiProvider(apiKey: string | undefined, thinking: ThinkingEffort = "default"): AIProvider {
  let client: GoogleGenAI | null = null;
  const getClient = () => {
    if (!apiKey) throw new ProviderError("NOT_CONFIGURED", "GEMINI_API_KEY is not set.");
    client ??= new GoogleGenAI({ apiKey });
    return client;
  };

  const call: ModelCall = async (prompt, schema, model, limits) => {
    const ai = getClient();
    const parts: Part[] = prompt.parts.map((p) =>
      p.kind === "text" ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.data.toString("base64") } },
    );
    const level = thinkingLevel(thinking, model);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: prompt.system,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          temperature: 0,
          // Counts thinking as well as the answer.
          ...(limits?.maxOutputTokens ? { maxOutputTokens: limits.maxOutputTokens } : {}),
          ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
        },
      });
      const used = res.usageMetadata;
      return {
        text: res.text ?? null,
        truncated: res.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS,
        usage: {
          inputTokens: used?.promptTokenCount ?? 0,
          outputTokens: (used?.candidatesTokenCount ?? 0) + (used?.thoughtsTokenCount ?? 0),
          imageTokens: used?.promptTokensDetails?.find((d) => d.modality === MediaModality.IMAGE)?.tokenCount ?? null,
          thinkingTokens: used?.thoughtsTokenCount ?? null,
        },
      };
    } catch (err) {
      throw toProviderError(err);
    }
  };

  return {
    async listModels() {
      return AI_MODELS.map((m) => ({ id: m.id, label: m.label, costTier: m.costTier }));
    },
    extract: (req) => extractWithRepair(call, req),
    proposeFields: (req) => proposeWithRepair(call, req),
  };
}
