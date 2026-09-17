import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

import { exportOptionsSchema, type ExportOptions } from "./schemas";

/**
 * Short-lived download links for an export. The link carries the options it was made with and is signed with
 * AUTH_SECRET, so nothing is stored; the download still needs the same signed-in user and re-checks the book.
 */

export const EXPORT_LINK_TTL_MS = 5 * 60_000;

const payloadSchema = z.object({ bookId: z.string(), userId: z.string(), options: exportOptionsSchema, exp: z.number() });
export type ExportLink = z.infer<typeof payloadSchema>;

function sign(body: string): string {
  return createHmac("sha256", `export:${getEnv().AUTH_SECRET}`).update(body).digest("base64url");
}

export function issueExportLink(bookId: string, userId: string, options: ExportOptions, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ bookId, userId, options, exp: now + EXPORT_LINK_TTL_MS })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readExportLink(token: string, now = Date.now()): ExportLink {
  const expired = new AppError("NOT_FOUND", "This download link has expired or isn't valid. Export again from the book.");
  const [body, signature] = token.split(".");
  if (!body || !signature) throw expired;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw expired;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw expired;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.exp < now) throw expired;
  return parsed.data;
}
