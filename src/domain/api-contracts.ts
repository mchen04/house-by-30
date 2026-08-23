import { z } from "zod";
import { storedPlanSchema } from "./plan-schema";

export const EXPECTED_SESSION_HEADER = "X-Kyle-Session-Id";
export const CACHE_OWNER_COOKIE = "kyle_cache_owner";
export const sessionIdSchema = z.uuid();

export const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  sessionId: sessionIdSchema.optional(),
});
export type User = z.infer<typeof userSchema>;
export const authenticatedUserSchema = userSchema.extend({
  sessionId: sessionIdSchema,
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const userResponseSchema = z.object({ user: authenticatedUserSchema });
export const signupAcceptedResponseSchema = z.object({
  accepted: z.literal(true),
});
export const plansResponseSchema = z.object({
  plans: z.array(storedPlanSchema),
});
export const bootstrapResponseSchema = z.object({
  user: authenticatedUserSchema,
  plans: z.array(storedPlanSchema),
});
export const planResponseSchema = z.object({ plan: storedPlanSchema });
export const syncResponseSchema = z.object({
  acknowledgements: z.array(
    z.union([
      z.object({
        mutationId: z.uuid(),
        rejected: z.never().optional(),
      }),
      z.object({
        mutationId: z.string(),
        rejected: z.literal(true),
      }),
    ]),
  ),
  plans: z.array(storedPlanSchema),
});
export const okResponseSchema = z.object({ ok: z.literal(true) });
export const accountExportSchema = z.object({
  format: z.literal("kyle-financial-export"),
  version: z.literal(2),
  exportedAt: z.iso.datetime(),
  account: z.object({ email: z.email() }),
  plans: z.array(storedPlanSchema),
});
