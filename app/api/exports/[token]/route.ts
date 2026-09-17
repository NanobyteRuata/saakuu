import { requireSessionUserId } from "@/lib/auth/session";
import { httpStatusFor, runAction } from "@/lib/errors";
import { exportLinkSchema } from "@/lib/export/schemas";
import { openExport } from "@/lib/export/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Streams the CSV for a download link, UTF-8 with BOM. The browser opens this directly, so errors are plain text. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return openExport(userId, parseInput(exportLinkSchema, (await params).token));
  });
  if (!result.ok) {
    const message = result.error.code === "VALIDATION" ? "This download link isn't valid. Export again from the book." : result.error.message;
    return new Response(message, { status: httpStatusFor(result.error.code), headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const { fileName, stream } = result.data;
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "_");
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
