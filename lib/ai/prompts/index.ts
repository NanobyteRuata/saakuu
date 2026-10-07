/** The prompt version new runs use. Bump by adding a new file; never edit an existing version. */
export { PROMPT_VERSION, buildExtractionPrompt, buildRepairInstruction } from "./v4";

/** The template proposal prompt version new proposals use (Phase 16; v3 in Phase 24). Same rule: never edit in place. */
export { TEMPLATE_PROMPT_VERSION, buildFieldProposalPrompt, buildFieldProposalRepair } from "./template-v3";
