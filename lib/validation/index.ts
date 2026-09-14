import { z } from "zod";

import { AppError } from "@/lib/errors";

/**
 * Zod conventions
 *
 * - Every entry point (Server Action, Route Handler, job processor) parses its input
 *   with a schema from this module or a feature module, via `parseInput`.
 * - Schemas are plain Zod and importable from client code, so forms share them.
 * - Schemas never import Prisma or anything server-only.
 * - Name schemas `<thing>Schema` and derive types with `z.infer`, e.g.
 *   `export type CreateBookInput = z.infer<typeof createBookSchema>`.
 */

/** Entity ID. All IDs are cuid2. */
export const idSchema = z.cuid2();

export const idListSchema = z.array(idSchema).min(1).max(500);

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

/** Cursor pagination query: `?cursor=&limit=`. */
export const paginationSchema = z.object({
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

/** Destructive endpoints require an explicit `confirm: true`. */
export const confirmSchema = z.literal(true, {
  error: "Confirmation is required for this action.",
});

/** Trimmed, non-empty human text (names, labels). Not normalised beyond trimming. */
export const labelSchema = z.string().trim().min(1).max(200);

/** Parses input or throws an `AppError("VALIDATION")` carrying flattened field errors. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", undefined, z.flattenError(parsed.error));
  }
  return parsed.data;
}

/** Converts `URLSearchParams` to a plain object for `parseInput`. Last value wins. */
export function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params.entries());
}
