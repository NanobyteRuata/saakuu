import { prisma } from "@/lib/db/client";
import { photoSelect, toPhotoView, type PhotoView } from "@/lib/photos/views";

import { requireTemplateAccess } from "./access";

/**
 * The pages a template was built against (Phase 15, decision 71).
 *
 * A specimen is an ordinary Document carrying `isSpecimen`, so this is a filtered document read
 * rather than a second kind of object. It is its own endpoint rather than a field on
 * `TemplateDetail` because the photo URLs are presigned and short-lived: the pane refetches them
 * after an upload, after the crop/rotate editor saves, and while a page is still being processed,
 * none of which should force a reload of the whole template.
 */
export const MAX_SPECIMENS = 20;

export type SpecimenDocument = {
  id: string;
  label: string | null;
  createdAt: string;
  photos: PhotoView[];
};

export async function listSpecimens(userId: string, templateId: string): Promise<{ documents: SpecimenDocument[] }> {
  await requireTemplateAccess(userId, templateId);
  const docs = await prisma.document.findMany({
    where: { templateId, deletedAt: null, isSpecimen: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_SPECIMENS,
    select: {
      id: true,
      label: true,
      createdAt: true,
      photos: { where: { deletedAt: null }, orderBy: { pageIndex: "asc" }, take: 50, select: photoSelect },
    },
  });
  return {
    documents: await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt.toISOString(),
        photos: await Promise.all(d.photos.map(toPhotoView)),
      })),
    ),
  };
}
