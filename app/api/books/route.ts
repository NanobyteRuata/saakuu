import { requireSessionUserId } from "@/lib/auth/session";
import { createBookSchema } from "@/lib/books/schemas";
import { createBook, listBookNames, listBooks } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { paginationSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const params = new URL(request.url).searchParams;
    const page = parseInput(paginationSchema, searchParamsToObject(params));
    // `?view=names` serves pickers, which need neither the counts nor the review progress.
    return params.get("view") === "names" ? listBookNames(userId, page) : listBooks(userId, page);
  });
  return resultResponse(result);
}

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(createBookSchema, await request.json().catch(() => null));
    return createBook(userId, input);
  });
  return resultResponse(result, 201);
}
