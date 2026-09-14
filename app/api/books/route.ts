import { requireSessionUserId } from "@/lib/auth/session";
import { createBookSchema } from "@/lib/books/schemas";
import { createBook, listBooks } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { paginationSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const page = parseInput(paginationSchema, searchParamsToObject(new URL(request.url).searchParams));
    return listBooks(userId, page);
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
