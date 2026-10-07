import type { FieldProposalRequest } from "../provider";
import type { ModelPrompt } from "../extract";

/**
 * Template proposal prompt, version 3 (Phase 24, docs/03 §12). NEVER edit this file once proposals have
 * used it: any change is a new version (template-v4.ts) so proposals stay comparable.
 *
 * The model reads a specimen page and lists the fields an operator would otherwise type in by hand.
 * Changed from version 2, which returned the header above a column in keys of its own: a field has
 * one name now, with the headers above it in front (decision 84), so `labelSource` and
 * `labelMeaning` carry them, joined with " › ". Which tick columns belong together is still not
 * proposed (decision 73): the operator combines them in a mapping.
 */

export const TEMPLATE_PROMPT_VERSION = "template-v3";

const TYPE_GUIDE = [
  '- "TEXT": names, addresses, free writing. The default when unsure.',
  '- "NUMBER": quantities that can have decimals, such as weight or money.',
  '- "INTEGER": counts and whole numbers.',
  '- "DATE": dates.',
  '- "AGE": ages, which are often written as years and months (for example 1 1/2 or 4/12).',
  '- "FRACTION": values written as fractions that are not ages.',
  '- "MARK": a single tick box, or a column that is ticked or left blank.',
  '- "CHOICE": a set of printed options where one is circled, ticked or written. Put the printed options in "choices", exactly as printed.',
].join("\n");

function kindRules(kind: FieldProposalRequest["kind"]): string {
  if (kind === "FORM") {
    return [
      "THIS DOCUMENT IS A FORM",
      "- A form has one set of values per document: each field is a printed label with a space, line or box next to it where something is written.",
      "- Propose one field per labelled place where a value is written, ticked or circled.",
      "- List fields in reading order: top to bottom, and within a line in the direction the script is read.",
      "- A printed question with options to circle or tick is ONE field of type CHOICE, not one field per option.",
      "- A single tick box with its own label is one field of type MARK.",
      '- A form can hold a small grid, such as doses and their dates. The form still has one set of values, so propose one field per grid cell where a value is written or would be written, including cells that are empty on this copy: other copies will fill them. labelSource is the row label and the column header as written, joined by " / ". A column that only names the rows is not a field.',
      "- Do not propose the form's title, headings, printed instructions, signatures, stamps or page numbers as fields.",
      '- Do not put a section heading in front of a label, unless the same labels appear under more than one heading. Then write the heading first, " › ", then the label, so the fields can be told apart.',
    ].join("\n");
  }
  return [
    "THIS DOCUMENT IS A TABLE",
    "- A table has one record per row: each field is a column of the ruled grid whose rows repeat.",
    "- Find that grid. Its column headers are the fields, and nothing else on the page is.",
    "- Propose one field per column, taken from its column header, in order from left to right as printed.",
    "- Include every column, including a running-number column and columns that look unimportant. The operator decides which to skip.",
    '- If a header has several levels (a header spanning sub-headers), propose one field per lowest-level column. Its labelSource is every level from the top down, as written, joined with " › ": for example "RDT Test › Positive › A".',
    "- Columns under the same spanning header start with that header, written the same way each time. A column with no header above its own is just its own header.",
    "- A column that is only ever ticked or left blank is type MARK.",
    "- Do not propose the table's title, row data, totals or text outside the table as fields. Never use a value written in a row as a label.",
    "- Labelled blanks outside the grid, filled once per page (such as a name, a township or a month written above it), are not columns, even when they are the only other writing on the page. Leave them out.",
  ].join("\n");
}

export function buildFieldProposalPrompt(req: FieldProposalRequest): ModelPrompt {
  const blocks = [
    "ROLE\nYou help an operator set up data entry for a handwritten paper document. Read the page and list the fields on it, so the operator does not have to type them in. Your list is a proposal: the operator checks every item against the paper.",
    [
      "LABELS",
      '- "labelSource" is the field\'s name: its label exactly as printed or written on the paper, in its own script. Do not translate, correct or shorten it. If a label is in Burmese, write it in Burmese.',
      '- When a header is printed above the field\'s own label, the name starts with that header: header, " › ", label. Several levels of header are all written, from the top down, each followed by " › ".',
      '- "labelMeaning" is a short English meaning of the name, with the same levels joined by " › " in the same order, or null if the whole name is already English.',
      "- If a place clearly holds a value but has no readable label, describe it briefly in English as labelSource and set labelMeaning to null. Never invent a label you cannot see.",
      '- "note" is null unless something on the paper helps read the field, such as a printed unit. A header is never a note.',
    ].join("\n"),
    `TYPES\nChoose "dataType" from what the label asks for and what is written:\n${TYPE_GUIDE}\n"choices" is an empty array for every type except CHOICE.`,
    kindRules(req.kind),
    "STRUCTURE\nReturn a flat list only. Do not group fields and do not nest them. A header is not a field of its own: it is repeated at the front of the name of each field under it.",
    req.languageHint ? `LANGUAGE\nLanguage of the document: ${req.languageHint}.` : null,
    req.glossary.length > 0
      ? `CONVENTIONS USED IN THIS DATASET\n${req.glossary.map((g) => `- "${g.term}": ${g.meaning}`).join("\n")}`
      : null,
    req.instructions ? `NOTES FROM THE OPERATOR ABOUT THIS KIND OF DOCUMENT\n${req.instructions}` : null,
    'If the pages are blank or hold no fields, return "fields" as an empty array.',
  ];

  const parts: ModelPrompt["parts"] = [];
  for (const image of req.images) {
    parts.push({ kind: "text", text: `Page ${image.pageIndex + 1}:` });
    parts.push({ kind: "image", data: image.data, mimeType: image.mimeType });
  }
  parts.push({ kind: "text", text: "List the fields on these pages in paper order. Respond with JSON only." });

  return { system: blocks.filter((b): b is string => b !== null).join("\n\n"), parts };
}

export function buildFieldProposalRepair(previousText: string | null, issues: string[]): string {
  return [
    "Your previous response could not be used because it did not follow the required structure:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Your previous response was:",
    previousText ?? "(empty)",
    "",
    "List the fields again and respond with corrected JSON only. Keep the labels exactly as written on the paper.",
  ].join("\n");
}
