import {
  planResponseSchema,
  plansResponseSchema,
} from "@/domain/api-contracts";
import { planBasicsSchema } from "@/domain/plan-schema";
import { currentUser, requestMatchesUser } from "@/server/auth/current-user";
import { database } from "@/server/database";
import {
  errorResponse,
  parseJsonRequest,
  validatedJsonResponse,
} from "@/server/http";
import {
  createPlanWithDefaults,
  listPlanSnapshot,
  PlanYearConflictError,
} from "@/server/plans/repository";

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return errorResponse(401, "Your session has expired.");
  if (!requestMatchesUser(request, user))
    return errorResponse(409, "The active account changed in another tab.");
  const { plans, planRevisions } = await listPlanSnapshot(database(), user.id);
  return validatedJsonResponse(plansResponseSchema, { plans, planRevisions });
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return errorResponse(401, "Your session has expired.");
  if (!requestMatchesUser(request, user))
    return errorResponse(409, "The active account changed in another tab.");
  const parsed = await parseJsonRequest(request, planBasicsSchema);
  if (!parsed.success) return parsed.response;
  try {
    const plan = await createPlanWithDefaults(database(), user.id, parsed.data);
    return validatedJsonResponse(planResponseSchema, { plan }, { status: 201 });
  } catch (error) {
    if (error instanceof PlanYearConflictError)
      return errorResponse(409, "A plan already exists for that year.");
    return errorResponse(500, "The plan could not be created.");
  }
}
