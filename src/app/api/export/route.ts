import { accountExportSchema } from "@/domain/api-contracts";
import { currentUser } from "@/server/auth/current-user";
import { database } from "@/server/database";
import { errorResponse } from "@/server/http";
import { exportAccount } from "@/server/plans/repository";

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return errorResponse(401, "Your session has expired.");
  if (new URL(request.url).searchParams.get("accountId") !== user.id)
    return errorResponse(409, "The active account changed in another tab.");
  const exported = accountExportSchema.safeParse(
    await exportAccount(database(), user.id, user.email),
  );
  if (!exported.success)
    return errorResponse(500, "The server produced an invalid response.");
  const body = JSON.stringify(exported.data, null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="house-by-30-export.json"',
      "Cache-Control": "private, no-store",
    },
  });
}
