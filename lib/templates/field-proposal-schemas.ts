import { z } from "zod";

import type { AiKeySource } from "@/lib/ai/keys";
import { modelIdSchema } from "@/lib/ai/models";
import type { CreditEstimate } from "@/lib/credits/rate";
import { nonceSchema } from "@/lib/extraction/schemas";
import { idSchema } from "@/lib/validation";

import type { FieldType } from "./schemas";

/** Template proposal input schemas (Phase 16). Client-safe: shared by the dialog and the handlers. */

/** More than any real paper has; a longer answer is the model listing row values as fields. */
export const MAX_PROPOSED_FIELDS = 100;

export const fieldProposalEstimateSchema = z.object({ documentId: idSchema, model: modelIdSchema.optional() });
export type FieldProposalEstimateInput = z.infer<typeof fieldProposalEstimateSchema>;

export const startFieldProposalSchema = z.object({ documentId: idSchema, model: modelIdSchema, nonce: nonceSchema });
export type StartFieldProposalInput = z.infer<typeof startFieldProposalSchema>;

/** Indexes into the proposal's items, in any order; the fields are created in paper order regardless. */
export const acceptFieldProposalSchema = z.object({
  include: z
    .array(z.number().int().min(0).max(MAX_PROPOSED_FIELDS - 1))
    .min(1, { error: "Choose at least one field to add." })
    .max(MAX_PROPOSED_FIELDS)
    .refine((a) => new Set(a).size === a.length, { error: "Each field can only be chosen once." }),
});
export type AcceptFieldProposalInput = z.infer<typeof acceptFieldProposalSchema>;

export type ProposedFieldView = {
  index: number;
  labelSource: string;
  labelMeaning: string | null;
  dataType: FieldType;
  choices: string[];
  note: string | null;
  /** A live field already carries this name, so the dialog starts it unticked. */
  alreadyInTree: boolean;
};

export type FieldProposalView = {
  id: string;
  documentId: string;
  state: "QUEUED" | "RUNNING" | "FAILED" | "COMPLETE";
  model: string;
  promptVersion: string;
  error: string | null;
  items: ProposedFieldView[];
  acceptedAt: string | null;
  acceptedCount: number;
  createdAt: string;
};

export type FieldProposalEstimate = {
  providerProblem: string | null;
  keySource: AiKeySource | null;
  keyHint: string | null;
  /** Why this page can't be read yet (still processing, not a specimen of this template), or null. */
  blocker: string | null;
  pages: number;
  estCostUsd: number;
  estSeconds: number;
  /** Phase 22: what this would use of the operator's credits and what they have; null where credits aren't in play. */
  credits: CreditEstimate | null;
  model: string;
};
