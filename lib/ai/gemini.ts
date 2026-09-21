import { ApiError, GoogleGenAI, type Part } from "@google/genai";

import { extractWithRepair, type ModelCall } from "./extract";
import { AI_MODELS } from "./models";
import { proposeWithRepair } from "./propose";
import { ProviderError, type AIProvider } from "./provider";

/**
 * Gemini implementation of `AIProvider`. Gemini types stay inside this file. Structured output uses
 * `responseJsonSchema` with the provider-neutral JSON schema, so nothing is converted.
 */

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ApiError) {
    if (err.status === 429) return new ProviderError("RATE_LIMITED", err.message);
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

export function createGeminiProvider(apiKey: string | undefined): AIProvider {
  let client: GoogleGenAI | null = null;
  const getClient = () => {
    if (!apiKey) throw new ProviderError("NOT_CONFIGURED", "GEMINI_API_KEY is not set.");
    client ??= new GoogleGenAI({ apiKey });
    return client;
  };

  const call: ModelCall = async (prompt, schema, model) => {
    const ai = getClient();
    const parts: Part[] = prompt.parts.map((p) =>
      p.kind === "text" ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.data.toString("base64") } },
    );
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: prompt.system,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          temperature: 0,
        },
      });
      return {
        text: res.text ?? null,
        usage: {
          inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
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
