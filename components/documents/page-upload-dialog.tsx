"use client";

import { PhotoIntakeDialog, type PageUploadTarget } from "@/components/photo/photo-intake";
import type { PhotoView } from "@/lib/photos/views";

export type { PageUploadTarget };

type Props = {
  target: PageUploadTarget | null;
  documentId: string;
  documentLabel: string | null;
  templateId: string;
  onOpenChange: (open: boolean) => void;
  onDone: (photo: PhotoView) => void;
};

/**
 * Re-shoots a page, or adds one to a document that was photographed incompletely (Phase 11, docs/05 §9).
 * Since Phase 15 it is the `page` mode of the one photo intake; what it keeps is still stated in exact
 * counts before the picker unlocks, which is the whole point of the feature (decision 59).
 */
export function PageUploadDialog({ target, documentId, documentLabel, templateId, onOpenChange, onDone }: Props) {
  if (!target) return null;
  return (
    <PhotoIntakeDialog
      mode={{ kind: "page", templateId, documentId, documentLabel, target }}
      open
      onOpenChange={onOpenChange}
      onDone={(result) => result.kind === "photo" && onDone(result.photo)}
      description={
        target.kind === "replace"
          ? `Puts a new photo in place of page ${target.page} of “${documentLabel ?? "this document"}”.`
          : `Adds a page to the end of “${documentLabel ?? "this document"}”, for a form that was photographed incompletely.`
      }
    />
  );
}
