import { z } from "zod";
import {
  filingStatusSchema,
  hsaAllocationSchema,
  hsaCoverageSchema,
  safeNonnegativeCentsSchema,
  stateCodeSchema,
} from "./plan-schema";
import type { StoredPlan } from "./stored-plan";
import { canonicalJson, parseSyncTarget, type SyncMutation } from "./sync";
import {
  applyDecodedEntityMutationInPlace,
  decodeEntitySyncMutation,
  type DecodedEntityMutation,
  type MutationMetadata,
} from "./sync-entity-decoder";

type ScalarMutation<K extends string, V> = MutationMetadata & {
  kind: "scalar";
  field: K;
  value: V;
};

export type DecodedSyncMutation =
  | ScalarMutation<"stateCode", StoredPlan["stateCode"]>
  | ScalarMutation<"filingStatus", StoredPlan["filingStatus"]>
  | ScalarMutation<"grossSalaryCents", number>
  | ScalarMutation<"additionalWageIncomeCents", number>
  | ScalarMutation<"spouseWageIncomeCents", number>
  | ScalarMutation<"otherOrdinaryIncomeCents", number>
  | ScalarMutation<"hsaCoverage", StoredPlan["hsaCoverage"]>
  | ScalarMutation<"primaryHsaEligible", boolean>
  | ScalarMutation<"spouseHsaEligible", boolean>
  | ScalarMutation<"primaryHsaCatchUpEligible", boolean>
  | ScalarMutation<"spouseHsaCatchUpEligible", boolean>
  | ScalarMutation<"primaryHsaFamilyAllocationPpm", number>
  | ScalarMutation<"spouseHsaFamilyAllocationPpm", number>
  | ScalarMutation<"startingSavingsCents", number | undefined>
  | DecodedEntityMutation;

function canonicalSyncIntent(mutation: SyncMutation): SyncMutation {
  const canonical = encodeSyncMutation(decodeSyncMutation(mutation));
  const intent = {
    ...canonical,
    updatedAt: canonical.intentUpdatedAt ?? canonical.updatedAt,
  };
  delete intent.intentUpdatedAt;
  delete intent.deliveryAfterMutationId;
  return intent;
}

export function syncIntentFingerprint(mutation: SyncMutation): string {
  return canonicalJson(canonicalSyncIntent(mutation));
}

function metadata(mutation: SyncMutation): MutationMetadata {
  return {
    mutationId: mutation.mutationId,
    planYear: mutation.planYear,
    updatedAt: mutation.updatedAt,
    ...(mutation.intentUpdatedAt
      ? { intentUpdatedAt: mutation.intentUpdatedAt }
      : {}),
    ...(mutation.deliveryAfterMutationId
      ? { deliveryAfterMutationId: mutation.deliveryAfterMutationId }
      : {}),
    ...(mutation.baseVersion !== undefined
      ? { baseVersion: mutation.baseVersion }
      : {}),
  };
}

export function decodeSyncMutation(
  mutation: SyncMutation,
): DecodedSyncMutation {
  const target = parseSyncTarget(mutation.field);
  if (!target) throw new Error(`Unsupported sync field: ${mutation.field}`);
  const base = metadata(mutation);
  if (target.kind === "scalar") {
    switch (target.field) {
      case "stateCode":
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value: stateCodeSchema.parse(mutation.value),
        };
      case "filingStatus":
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value: filingStatusSchema.parse(mutation.value),
        };
      case "hsaCoverage":
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value: hsaCoverageSchema.parse(mutation.value),
        };
      case "primaryHsaEligible":
      case "spouseHsaEligible":
      case "primaryHsaCatchUpEligible":
      case "spouseHsaCatchUpEligible":
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value: z.boolean().parse(mutation.value),
        };
      case "primaryHsaFamilyAllocationPpm":
      case "spouseHsaFamilyAllocationPpm":
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value: hsaAllocationSchema.parse(mutation.value),
        };
      case "startingSavingsCents":
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value:
            mutation.value === null
              ? undefined
              : safeNonnegativeCentsSchema.parse(mutation.value),
        };
      default:
        return {
          ...base,
          kind: "scalar",
          field: target.field,
          value: safeNonnegativeCentsSchema.parse(mutation.value),
        };
    }
  }
  return decodeEntitySyncMutation(mutation, target, base);
}

export function encodeSyncMutation(
  mutation: DecodedSyncMutation,
): SyncMutation {
  return {
    ...metadata(mutation),
    field: mutation.field,
    value: mutation.value ?? null,
  };
}

export function applyDecodedSyncMutation(
  plan: StoredPlan,
  mutation: DecodedSyncMutation,
): StoredPlan {
  return applyDecodedSyncMutations(plan, [mutation]);
}

/**
 * Projects mutations in order onto one copy of the plan. Copying once per batch
 * instead of once per mutation keeps a batch linear in the plan size.
 */
export function applyDecodedSyncMutations(
  plan: StoredPlan,
  mutations: readonly DecodedSyncMutation[],
): StoredPlan {
  const next = structuredClone(plan);
  for (const mutation of mutations)
    applyDecodedSyncMutationInPlace(next, mutation);
  return next;
}

/** Applies the mutation to a plan the caller exclusively owns. */
export function applyDecodedSyncMutationInPlace(
  next: StoredPlan,
  mutation: DecodedSyncMutation,
): void {
  if (mutation.kind === "scalar") {
    switch (mutation.field) {
      case "stateCode":
        next.stateCode = mutation.value;
        break;
      case "filingStatus":
        next.filingStatus = mutation.value;
        break;
      case "grossSalaryCents":
        next.grossSalaryCents = mutation.value;
        break;
      case "additionalWageIncomeCents":
        next.additionalWageIncomeCents = mutation.value;
        break;
      case "spouseWageIncomeCents":
        next.spouseWageIncomeCents = mutation.value;
        break;
      case "otherOrdinaryIncomeCents":
        next.otherOrdinaryIncomeCents = mutation.value;
        break;
      case "hsaCoverage":
        next.hsaCoverage = mutation.value;
        break;
      case "primaryHsaEligible":
        next.primaryHsaEligible = mutation.value;
        break;
      case "spouseHsaEligible":
        next.spouseHsaEligible = mutation.value;
        break;
      case "primaryHsaCatchUpEligible":
        next.primaryHsaCatchUpEligible = mutation.value;
        break;
      case "spouseHsaCatchUpEligible":
        next.spouseHsaCatchUpEligible = mutation.value;
        break;
      case "primaryHsaFamilyAllocationPpm":
        next.primaryHsaFamilyAllocationPpm = mutation.value;
        break;
      case "spouseHsaFamilyAllocationPpm":
        next.spouseHsaFamilyAllocationPpm = mutation.value;
        break;
      case "startingSavingsCents":
        next.startingSavingsCents = mutation.value;
        break;
    }
    return;
  }
  applyDecodedEntityMutationInPlace(next, mutation);
}
