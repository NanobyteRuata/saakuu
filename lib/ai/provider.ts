import type { FieldType, GroupSelection, MarkSymbols, TemplateKind } from "@/lib/templates/schemas";

import type { AIModelId } from "./models";

/**
 * The AI provider boundary (docs/03 §1). Everything here is provider-neutral: Gemini is one
 * implementation (`gemini.ts`) and none of its types leave that file. Server-only.
 */

export const CONTENT_STATES = ["HAS_CONTENT", "EMPTY", "NO_ROWS_FOUND"] as const;
export type ExtractedContentState = (typeof CONTENT_STATES)[number];

export const ROW_TYPES = ["DATA", "HEADER", "SUBTOTAL", "TOTAL", "NOTE"] as const;
export type RowType = (typeof ROW_TYPES)[number];

export const VALUE_STATES = ["OK", "ILLEGIBLE", "EMPTY", "DASH", "NOT_APPLICABLE"] as const;
export type ValueState = (typeof VALUE_STATES)[number];

export type NumeralSystem = "AUTO" | "LATIN" | "MYANMAR";
export type DateEra = "GREGORIAN" | "BUDDHIST" | "MYANMAR";

/** One header on the paper, from the top down: the label as written and its English meaning. */
export type PathLabel = { label: string; meaning: string | null };

export type SnapshotField = {
  id: string;
  /** Header path from the top group down to the field itself. */
  path: PathLabel[];
  dataType: FieldType;
  /** MANUAL fields are never part of a snapshot. */
  mode: "EXTRACT" | "SKIP";
  note: string | null;
  choices: string[];
  markSymbols: MarkSymbols | null;
  isSequence: boolean;
};

export type SnapshotGroup = {
  id: string;
  path: PathLabel[];
  note: string | null;
  selection: GroupSelection;
  /** Selection groups only: option field ids in paper order. */
  optionFieldIds: string[];
};

export type TemplateSnapshot = {
  id: string;
  kind: TemplateKind;
  languageHint: string | null;
  instructions: string | null;
  anchors: string[];
  /** EXTRACT and SKIP fields in paper order. */
  fields: SnapshotField[];
  /** Groups that carry a note or a selection, in paper order. */
  groups: SnapshotGroup[];
};

export type Bbox = { x: number; y: number; w: number; h: number };

export type RawValueDTO = {
  fieldId: string;
  valueText: string | null;
  altValueText: string | null;
  state: ValueState;
  isDitto: boolean;
  confidence: number | null;
  bbox: Bbox | null;
};

export type RawRecordDTO = {
  recordIndex: number;
  rowType: RowType;
  struckThrough: boolean;
  pageIndex: number;
  values: RawValueDTO[];
};

export type ExtractionImage = { data: Buffer; mimeType: string; pageIndex: number };

export type ExtractionRequest = {
  images: ExtractionImage[];
  template: TemplateSnapshot;
  glossary: { term: string; meaning: string }[];
  book: { numeralSystem: NumeralSystem; dateEra: DateEra };
  model: AIModelId;
};

/** What was sent back, kept for debugging on the run. */
export type ResponseLog = { attempt: number; text: string | null; issues: string[] };

export type ExtractionResult = {
  contentState: ExtractedContentState;
  anchorsFound: string[];
  records: RawRecordDTO[];
  usage: { inputTokens: number; outputTokens: number };
  rawResponse: { responses: ResponseLog[] };
};

export type ModelInfo = { id: AIModelId; label: string; costTier: "low" | "high" };

/**
 * Phase 16: read a specimen and propose the template's fields. Flat fields only (decision 73) — groups
 * and selection structure stay manual. The proposal is shown to the operator and written only on their
 * confirmation; nothing here touches the template.
 */
export type FieldProposalRequest = {
  images: ExtractionImage[];
  kind: TemplateKind;
  languageHint: string | null;
  instructions: string | null;
  glossary: { term: string; meaning: string }[];
  model: AIModelId;
};

export type ProposedFieldDTO = {
  /** The label exactly as written on the paper, in its own script. */
  labelSource: string;
  /** A short English meaning, where the label is not already English. */
  labelMeaning: string | null;
  dataType: FieldType;
  /** CHOICE only: the printed options, as written. */
  choices: string[];
  note: string | null;
};

export type FieldProposalResult = {
  /** In paper order. */
  fields: ProposedFieldDTO[];
  usage: { inputTokens: number; outputTokens: number };
  rawResponse: { responses: ResponseLog[] };
};

export interface AIProvider {
  listModels(): Promise<ModelInfo[]>;
  extract(req: ExtractionRequest): Promise<ExtractionResult>;
  proposeFields(req: FieldProposalRequest): Promise<FieldProposalResult>;
}

export type ProviderErrorKind = "RATE_LIMITED" | "UNAVAILABLE" | "BAD_REQUEST" | "NOT_CONFIGURED" | "KEY_REFUSED" | "INVALID_RESPONSE";

/** A provider failure in plain language. `transient` kinds are worth retrying later. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly rawResponse: { responses: ResponseLog[] } | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    extra: { usage?: { inputTokens: number; outputTokens: number }; rawResponse?: { responses: ResponseLog[] } } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.usage = extra.usage ?? { inputTokens: 0, outputTokens: 0 };
    this.rawResponse = extra.rawResponse ?? null;
  }

  get transient(): boolean {
    return this.kind === "RATE_LIMITED" || this.kind === "UNAVAILABLE";
  }
}

/**
 * A missing or refused **server** key (Phase 21). The operator reading this cannot fix either, so it
 * says whose problem it is and stops; the kind is in the worker's log for whoever can.
 */
export const SERVER_SIDE_PROBLEM = "Reading pages isn't working right now. This is a problem on SaaKuu's side, not with your pages. Try again later.";

/**
 * The server's own key is missing or refused: nobody can read anything until whoever runs the
 * deployment fixes it, and the operator has been told only to wait. Callers log this as an error, not
 * as one more failed run.
 */
export function isServerKeyFailure(err: ProviderError, keySource: "user" | "server" | "fake"): boolean {
  return keySource === "server" && (err.kind === "KEY_REFUSED" || err.kind === "NOT_CONFIGURED");
}

/**
 * Plain-language message stored on a failed run and shown next to its pages. `keySource` decides who
 * is being asked to fix a key problem (Phase 12): the user who brought their own, or whoever runs the
 * server. Telling a user to "check the server's key" when it is their own key that was refused sends
 * them to someone who cannot help.
 */
export function providerErrorMessage(err: ProviderError, keySource: "user" | "server" | "fake" = "server"): string {
  const ownKey = keySource === "user";
  switch (err.kind) {
    case "RATE_LIMITED":
      return "The AI service is limiting how fast pages can be sent. Retry these pages in a few minutes.";
    case "UNAVAILABLE":
      return "The AI service didn't respond. Retry these pages.";
    case "NOT_CONFIGURED":
      // Only reachable for the server key: a `user` source carries a decrypted, non-empty key by
      // construction, and one that would not decrypt never reaches the provider at all.
      return SERVER_SIDE_PROBLEM;
    case "KEY_REFUSED":
      return ownKey
        ? "The AI service refused your own API key. Check it on your account page, including whether it can use this model."
        : SERVER_SIDE_PROBLEM;
    case "BAD_REQUEST":
      return `The AI service refused these pages. ${err.message}`;
    case "INVALID_RESPONSE":
      return "The AI's answer didn't fit this template, even after asking it again. Retry these pages or try the other model.";
  }
}
