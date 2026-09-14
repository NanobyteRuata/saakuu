import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { createTemplateSchema } from "@/lib/templates/schemas";
import { createTemplate, listTemplates } from "@/lib/templates/service";
import { idSchema, paginationSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const page = parseInput(paginationSchema, searchParamsToObject(new URL(request.url).searchParams));
    return listTemplates(userId, bookId, page);
  });
  return resultResponse(result);
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(createTemplateSchema, await request.json().catch(() => null));
    return createTemplate(userId, bookId, input);
  });
  return resultResponse(result, 201);
}
