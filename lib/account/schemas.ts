import { z } from "zod";

/** Account input schemas (docs/04 → Account). Client-safe: shared by the form and the handler. */

/**
 * A Gemini key is a long opaque string; the bounds only catch an empty paste or a pasted paragraph.
 * Whether the key actually works is answered by the first run, not here — checking it would cost a
 * real model call.
 */
export const saveAiKeySchema = z.object({
  key: z
    .string()
    .trim()
    .min(20, "That doesn't look like an API key. Paste the whole key.")
    .max(200, "That's longer than an API key. Paste just the key."),
});
export type SaveAiKeyInput = z.infer<typeof saveAiKeySchema>;

/** `Request more` (Phase 22): an optional line saying what the credits are for. */
export const creditRequestSchema = z.object({
  note: z.string().trim().max(500, "Keep the note under 500 characters.").optional(),
});
export type CreditRequestInput = z.infer<typeof creditRequestSchema>;
