import sharp from "sharp";

import { extractWithRepair } from "./extract";
import { AI_MODELS } from "./models";
import { proposeWithRepair } from "./propose";
import {
  ProviderError,
  type AIProvider,
  type ExtractionImage,
  type ExtractionRequest,
  type ExtractionResult,
  type FieldProposalRequest,
  type FieldProposalResult,
  type ProposedFieldDTO,
} from "./provider";

/**
 * Deterministic stand-in for a real model, for local work without an API key and for CI. It never
 * touches the network and goes through the same validation as a real response.
 * - A near-white page reads as EMPTY.
 * - Otherwise: a form gets one record, a table two rows on its first page, with a sample value for
 *   every Extract field (ticks for mark fields).
 * - A template proposal (Phase 16) is a fixed field list per kind: twelve labelled fields for a form,
 *   six column headers for a table, so the two kinds visibly differ on the same page. A blank page
 *   proposes nothing.
 * - `AI_FAKE_BEHAVIOUR=error` or `rate-limited` fails every call, to exercise failure handling.
 */

export type FakeBehaviour = "ok" | "error" | "rate-limited" | "slow";

/** How long `slow` waits before answering: long enough to kill a worker mid-run by hand. */
const SLOW_MS = 90_000;

async function isBlank(image: ExtractionImage): Promise<boolean> {
  const stats = await sharp(image.data).greyscale().stats();
  const channel = stats.channels[0];
  return channel !== undefined && channel.mean > 235 && channel.stdev < 8;
}

async function fakeResponse(req: ExtractionRequest): Promise<string> {
  const blank = await Promise.all(req.images.map(isBlank));
  const firstWithContent = req.images.find((_, i) => !blank[i]);
  if (!firstWithContent) return JSON.stringify({ contentState: "EMPTY", anchorsFound: [], records: [] });
  const fields = req.template.fields.filter((f) => f.mode === "EXTRACT");
  const rows = req.template.kind === "FORM" ? 1 : 2;
  const records = Array.from({ length: rows }, (_, r) => ({
    recordIndex: r,
    rowType: "DATA",
    struckThrough: false,
    pageIndex: firstWithContent.pageIndex,
    values: fields.map((f, i) => ({
      fieldId: f.id,
      valueText: f.dataType === "MARK" ? (i % 2 === 0 ? "✓" : null) : f.isSequence ? String(r + 1) : `${f.path.at(-1)?.label ?? "value"} ${r + 1}`,
      altValueText: null,
      state: f.dataType === "MARK" && i % 2 !== 0 ? "EMPTY" : "OK",
      isDitto: false,
      confidence: 0.5,
      bbox: { x: 0.1, y: Math.min(0.9, 0.1 + (r + i) * 0.04), w: 0.3, h: 0.03 },
    })),
  }));
  return JSON.stringify({ contentState: "HAS_CONTENT", anchorsFound: req.template.anchors, records });
}

const field = (labelSource: string, labelMeaning: string, dataType: ProposedFieldDTO["dataType"], choices: string[] = []): ProposedFieldDTO => ({
  labelSource,
  labelMeaning,
  dataType,
  choices,
  note: null,
});

/** A twelve-field Burmese registration card, in paper order. */
const FAKE_FORM_FIELDS: ProposedFieldDTO[] = [
  field("အမည်", "Name", "TEXT"),
  field("အဖအမည်", "Father's name", "TEXT"),
  field("မွေးသက္ကရာဇ်", "Date of birth", "DATE"),
  field("အသက်", "Age", "AGE"),
  field("ကျား/မ", "Sex", "CHOICE", ["ကျား", "မ"]),
  field("မှတ်ပုံတင်အမှတ်", "Registration number", "TEXT"),
  field("ကျေးရွာ", "Village", "TEXT"),
  field("မြို့နယ်", "Township", "TEXT"),
  field("ကိုယ်အလေးချိန်", "Weight", "NUMBER"),
  field("ကာကွယ်ဆေးထိုးပြီး", "Vaccinated", "MARK"),
  field("ရက်စွဲ", "Date", "DATE"),
  field("မှတ်ချက်", "Remarks", "TEXT"),
];

/** A six-column register, left to right. */
const FAKE_TABLE_FIELDS: ProposedFieldDTO[] = [
  field("စဉ်", "Serial number", "INTEGER"),
  field("အမည်", "Name", "TEXT"),
  field("အသက်", "Age", "AGE"),
  field("နေရပ်", "Address", "TEXT"),
  field("အပြုသဘော", "Positive", "MARK"),
  field("မှတ်ချက်", "Remarks", "TEXT"),
];

async function fakeProposal(req: FieldProposalRequest): Promise<string> {
  const blank = await Promise.all(req.images.map(isBlank));
  if (blank.every(Boolean)) return JSON.stringify({ fields: [] });
  return JSON.stringify({ fields: req.kind === "FORM" ? FAKE_FORM_FIELDS : FAKE_TABLE_FIELDS });
}

async function misbehave(behaviour: FakeBehaviour): Promise<void> {
  if (behaviour === "error") throw new ProviderError("UNAVAILABLE", "Fake provider forced an outage.");
  if (behaviour === "rate-limited") throw new ProviderError("RATE_LIMITED", "Fake provider forced a rate limit.");
  if (behaviour === "slow") await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
}

export function createFakeProvider(behaviour: FakeBehaviour): AIProvider {
  return {
    async listModels() {
      return AI_MODELS.map((m) => ({ id: m.id, label: m.label, costTier: m.costTier }));
    },
    async extract(req: ExtractionRequest): Promise<ExtractionResult> {
      return extractWithRepair(async () => {
        await misbehave(behaviour);
        return { text: await fakeResponse(req), usage: { inputTokens: 258 * req.images.length, outputTokens: 100 } };
      }, req);
    },
    async proposeFields(req: FieldProposalRequest): Promise<FieldProposalResult> {
      return proposeWithRepair(async () => {
        await misbehave(behaviour);
        return { text: await fakeProposal(req), usage: { inputTokens: 258 * req.images.length, outputTokens: 400 } };
      }, req);
    },
  };
}
