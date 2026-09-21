"use client";

import { PhotoIntakeDialog, type TemplateOption } from "@/components/photo/photo-intake";

export type { TemplateOption };

type Props = {
  bookId: string;
  templates: TemplateOption[];
  /** Pre-selected template, e.g. the Documents filter or the template card the dialog was opened from. */
  initialTemplateId: string | null;
  /** Opened from a template card: the template can't be changed. */
  lockTemplate?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog closed; documents may have been created, grouped or deleted. */
  onClosed: () => void;
};

/**
 * Uploading a batch of documents (docs/05 §9). Since Phase 15 this is the `batch` mode of the one
 * photo intake, which is also the specimen upload, `Try one document` and replace/add page.
 */
export function UploadDialog({ templates, initialTemplateId, lockTemplate = false, open, onOpenChange, onClosed }: Props) {
  return (
    <PhotoIntakeDialog
      mode={{ kind: "batch", templates, initialTemplateId, lockTemplate }}
      open={open}
      onOpenChange={onOpenChange}
      // `Done` closes through the dialog, so `onClosed` runs and the documents list reloads.
      onClosed={onClosed}
      description="Each photo becomes its own document. Group the pages that belong to one record, and fix or remove any photo before you finish."
    />
  );
}
