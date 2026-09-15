/**
 * Pure planners for changing which photos belong to which document and in what page order.
 * They decide what gets written, so they are unit-tested: no photo may be dropped or duplicated,
 * and page order is kept wherever the user didn't ask to change it.
 */

export type DocumentPages = { documentId: string; photoIds: string[] };

export type PageAssignment = { photoId: string; documentId: string; pageIndex: number };

export type RestructurePlan = {
  /** Every photo in every involved document, with its final document and page index. */
  assignments: PageAssignment[];
  /** Involved documents left with no photos. */
  emptied: string[];
};

export type Problem = { problem: string };

function duplicates(ids: string[]): boolean {
  return new Set(ids).size !== ids.length;
}

function locate(docs: DocumentPages[]): Map<string, string> {
  const where = new Map<string, string>();
  for (const d of docs) for (const p of d.photoIds) where.set(p, d.documentId);
  return where;
}

function assign(documentId: string, photoIds: string[]): PageAssignment[] {
  return photoIds.map((photoId, pageIndex) => ({ photoId, documentId, pageIndex }));
}

/**
 * Groups `photoIds` into one document: the document of the first listed photo. Its pages become
 * the listed photos in the listed order, followed by its own unlisted pages in their old order.
 * Other involved documents keep their unlisted pages, renumbered; those left empty are reported.
 */
export function planGroup(docs: DocumentPages[], photoIds: string[]): RestructurePlan | Problem {
  if (photoIds.length < 2) return { problem: "Select at least 2 photos to group into one document." };
  if (duplicates(photoIds)) return { problem: "A photo was selected twice." };
  const where = locate(docs);
  const first = photoIds[0];
  const targetId = first === undefined ? undefined : where.get(first);
  if (!targetId || photoIds.some((p) => !where.has(p))) {
    return { problem: "Some of these photos aren't in the documents being grouped. Reload and try again." };
  }
  const selected = new Set(photoIds);
  const assignments: PageAssignment[] = [];
  const emptied: string[] = [];
  for (const d of docs) {
    const rest = d.photoIds.filter((p) => !selected.has(p));
    if (d.documentId === targetId) {
      assignments.push(...assign(d.documentId, [...photoIds, ...rest]));
    } else {
      assignments.push(...assign(d.documentId, rest));
      if (rest.length === 0) emptied.push(d.documentId);
    }
  }
  return { assignments, emptied };
}

/** Moves `photoIds` (kept in page order) out of `doc` into a new document `newDocumentId`. */
export function planSplit(doc: DocumentPages, photoIds: string[], newDocumentId: string): RestructurePlan | Problem {
  if (photoIds.length === 0) return { problem: "Select the pages to split into a new document." };
  if (duplicates(photoIds)) return { problem: "A page was selected twice." };
  const selected = new Set(photoIds);
  if (photoIds.some((p) => !doc.photoIds.includes(p))) {
    return { problem: "Some of these pages aren't in this document any more. Reload and try again." };
  }
  if (selected.size === doc.photoIds.length) {
    return { problem: "Leave at least one page in this document. To move every page, there's nothing to split." };
  }
  const moving = doc.photoIds.filter((p) => selected.has(p));
  const staying = doc.photoIds.filter((p) => !selected.has(p));
  return { assignments: [...assign(doc.documentId, staying), ...assign(newDocumentId, moving)], emptied: [] };
}

/** Sets the page order of `doc`; `photoIds` must list exactly its pages. */
export function planReorder(doc: DocumentPages, photoIds: string[]): RestructurePlan | Problem {
  if (duplicates(photoIds) || photoIds.length !== doc.photoIds.length || photoIds.some((p) => !doc.photoIds.includes(p))) {
    return { problem: "The pages of this document changed while you were reordering them. Reload and try again." };
  }
  return { assignments: assign(doc.documentId, photoIds), emptied: [] };
}

export function isProblem<T extends object>(value: T | Problem): value is Problem {
  return "problem" in value;
}
