import { z } from "zod";
import { fieldVersionsSchema, planYearSchema } from "@/domain/plan-schema";
import { SYNC_BATCH_SIZE } from "@/domain/sync";

export const credentialsSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((value) => value.trim().toLowerCase()),
  password: z.string().nonempty(),
});

export const signupCredentialsSchema = credentialsSchema;

export const copyPlanSchema = z.object({
  sourceYear: planYearSchema,
  targetYear: planYearSchema,
  expectedSourceUpdatedAt: z.iso.datetime(),
  expectedSourceFieldVersions: fieldVersionsSchema,
});

export const syncRequestSchema = z.object({
  mutations: z.array(z.unknown()).min(1).max(SYNC_BATCH_SIZE),
});
