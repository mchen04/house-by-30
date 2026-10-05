import "server-only";

import type { Sql } from "postgres";
import { z } from "zod";
import {
  actualDateIsAdmissible,
  localDateBelongsToYear,
} from "@/domain/local-calendar-date";
import { normalizedFullPlanSchema } from "@/domain/plan-schema";
import {
  applyDecodedSyncMutationInPlace,
  applyDecodedSyncMutations,
  decodeSyncMutation,
  encodeSyncMutation,
  syncIntentFingerprint,
  type DecodedSyncMutation,
} from "@/domain/sync-decoder";
import {
  canonicalJson,
  entityFieldForTarget,
  isIncomingVersionNewer,
  latestVersionForField,
  normalizeClientTimestamp,
  parseSyncTarget,
  persistedSyncMutationEnvelopeSchema,
  syncFieldForTarget,
  syncMutationSchema,
  type SyncMutation,
} from "@/domain/sync";
import { canonicalUuidSchema } from "@/domain/sync-field";
import { transportSafeFieldVersion } from "@/domain/field-version";
import type { FieldVersions, StoredPlan } from "@/domain/stored-plan";
import {
  getPlanByYearInTransaction,
  listPlans,
} from "@/server/plans/repository";
import { parseFieldVersions } from "@/server/field-versions";
import {
  isForeignKeyConstraintViolation,
  isRejectableMutationViolation,
} from "@/server/postgres-errors";
import { persistDecodedEntityMutation } from "@/server/sync/entity-repository";

class InvalidFinalPlanError extends Error {
  constructor(readonly refusable: readonly string[] = []) {
    super();
  }
}

/**
 * The smallest set of mutations whose removal makes the batch admissible again.
 *
 * Candidates are judged by the plan they *finish* in, never by the plan they
 * pass through, so the answer does not depend on the order the batch arrived
 * in. A coupled save — leaving married-filing-jointly changes filing status,
 * spouse wages and a benefit's owner together — is inadmissible after any one
 * of its parts and admissible after all of them, and must survive intact.
 */
/**
 * Rounds of single-removal search. Each round costs one projection per
 * surviving mutation, so the total is bounded at `ROUNDS × batch` rather than
 * growing with the square of the batch — the search runs while the plan row is
 * held `FOR UPDATE`, and an unbounded one outlived the connection's
 * idle-in-transaction timeout, which killed the request and left the whole
 * batch without receipts.
 */
const REFUSAL_SEARCH_ROUNDS = 3;

function refusableMutationIds(
  initialPlan: StoredPlan,
  appliedMutations: readonly DecodedSyncMutation[],
): string[] {
  const project = (candidates: readonly DecodedSyncMutation[]): StoredPlan =>
    applyDecodedSyncMutations(initialPlan, candidates);
  let survivors = [...appliedMutations];
  const refused: string[] = [];
  for (let round = 0; round < REFUSAL_SEARCH_ROUNDS; round += 1) {
    if (isAdmissibleProjection(project(survivors))) return refused;
    const culprit = survivors.findIndex((_, index) =>
      isAdmissibleProjection(
        project(survivors.filter((__, other) => other !== index)),
      ),
    );
    // Nothing was proven guilty. Refusing by recency instead would discard
    // whichever edits happened to arrive last — work the batch never showed to
    // be at fault — and each would carry a receipt, so the client would delete
    // it silently. Give up the search and let the caller reject the year, which
    // at least surfaces as a sync error the owner can see.
    if (culprit < 0) return [];
    refused.push(survivors[culprit].mutationId);
    survivors = survivors.filter((_, index) => index !== culprit);
  }
  return isAdmissibleProjection(project(survivors)) ? refused : [];
}

function isAdmissibleProjection(plan: StoredPlan): boolean {
  return (
    plan.transactions.every(({ date }) =>
      localDateBelongsToYear(date, plan.year),
    ) && normalizedFullPlanSchema.safeParse(plan).success
  );
}
export class SyncPlanNotFoundError extends Error {}

function mutationUsesFutureActualDate(
  mutation: DecodedSyncMutation,
  receivedAt: Date,
): boolean {
  if (mutation.kind !== "transaction") return false;
  if (mutation.property === "date")
    return !actualDateIsAdmissible(mutation.value, receivedAt);
  return (
    mutation.property === null &&
    mutation.value !== null &&
    !actualDateIsAdmissible(mutation.value.date, receivedAt)
  );
}

interface CommittedSyncAcknowledgement {
  mutationId: string;
  applied: boolean;
  rejected?: never;
}

interface RejectedSyncAcknowledgement {
  mutationId: string;
  applied: false;
  rejected: true;
}

type SyncAcknowledgement =
  CommittedSyncAcknowledgement | RejectedSyncAcknowledgement;

type PlanYearSyncResult =
  | {
      kind: "committed";
      acknowledgements: CommittedSyncAcknowledgement[];
    }
  | { kind: "rejected"; acknowledgements: RejectedSyncAcknowledgement[] };

const receiptResultSchema = z.object({
  fingerprint: z.string().optional(),
  applied: z.boolean().optional(),
});

function legacyDeliveryFingerprint(mutation: SyncMutation): string {
  const delivered = { ...mutation };
  delete delivered.intentUpdatedAt;
  delete delivered.deliveryAfterMutationId;
  return canonicalJson(delivered);
}

function legacyReceiptFingerprintCandidates(fingerprint: string): Set<string> {
  const candidates = new Set([fingerprint]);
  try {
    const parsed = JSON.parse(fingerprint) as unknown;
    const envelope = persistedSyncMutationEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) return candidates;
    const baseVersion = transportSafeFieldVersion(envelope.data.baseVersion);
    const transportMutation =
      baseVersion === undefined
        ? envelope.data
        : { ...envelope.data, baseVersion };
    candidates.add(syncIntentFingerprint(transportMutation));
    candidates.add(legacyDeliveryFingerprint(transportMutation));
  } catch {
    return candidates;
  }
  return candidates;
}

function versionsJson(
  versions: FieldVersions,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(versions).flatMap(([field, version]) =>
      version
        ? [
            [
              field,
              { updatedAt: version.updatedAt, mutationId: version.mutationId },
            ],
          ]
        : [],
    ),
  );
}

async function reconcilePlanYear(
  sql: Sql,
  userId: string,
  planYear: number,
  yearMutations: DecodedSyncMutation[],
  receivedAt: Date,
  /**
   * Mutations the first attempt identified as the reason the finished batch was
   * inadmissible. They are refused by id on the second pass so the rest commit
   * and every mutation still earns a receipt.
   */
  refusedIds: ReadonlySet<string> = new Set(),
): Promise<PlanYearSyncResult> {
  try {
    const acknowledgements = await sql.begin(async (transaction) => {
      const result: CommittedSyncAcknowledgement[] = [];
      const mutationIds = yearMutations.map(({ mutationId }) => mutationId);
      const advisoryKeys = mutationIds.map(
        (mutationId) => `${userId}:${mutationId}`,
      );
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(key, 0))
        FROM unnest(${transaction.array(advisoryKeys, 25)}::text[]) AS key
        ORDER BY key
      `;
      const priorRows = await transaction<
        { mutation_id: string; result: unknown }[]
      >`
        SELECT DISTINCT ON (lower(mutation_id))
          lower(mutation_id) AS mutation_id,
          result
        FROM applied_mutations
        WHERE user_id = ${userId}
          AND lower(mutation_id) = ANY(${transaction.array(mutationIds, 25)}::text[])
        ORDER BY lower(mutation_id), applied_at DESC, mutation_id
      `;
      const priorById = new Map(
        priorRows.map((row) => [row.mutation_id, row.result]),
      );
      const planRows = await transaction<
        { id: string; field_versions: unknown }[]
      >`
        SELECT id, field_versions FROM plans
        WHERE user_id = ${userId} AND year = ${planYear}
        FOR UPDATE
      `;
      const plan = planRows[0];
      if (!plan) throw new SyncPlanNotFoundError();
      const initialPlan = await getPlanByYearInTransaction(
        transaction,
        userId,
        planYear,
      );
      if (!initialPlan) throw new SyncPlanNotFoundError();
      let projectedPlan = initialPlan;
      const versions = parseFieldVersions(plan.field_versions);
      const receipts: Array<{
        mutation_id: string;
        result: { applied: boolean; fingerprint: string };
      }> = [];
      const appliedMutations: DecodedSyncMutation[] = [];
      for (const [index, mutation] of yearMutations.entries()) {
        const transportMutation = encodeSyncMutation(mutation);
        const fingerprint = syncIntentFingerprint(transportMutation);
        const prior = priorById.get(mutation.mutationId);
        if (prior !== undefined) {
          const receipt = receiptResultSchema.parse(
            typeof prior === "string" ? JSON.parse(prior) : prior,
          );
          const priorFingerprint = receipt.fingerprint;
          const deliveryFingerprint =
            legacyDeliveryFingerprint(transportMutation);
          const acceptedFingerprints = new Set([
            ...legacyReceiptFingerprintCandidates(fingerprint),
            ...legacyReceiptFingerprintCandidates(deliveryFingerprint),
          ]);
          if (
            priorFingerprint !== undefined &&
            ![...legacyReceiptFingerprintCandidates(priorFingerprint)].some(
              (candidate) => acceptedFingerprints.has(candidate),
            )
          ) {
            // A reused id carrying different content is a client fault, but
            // throwing aborted the whole plan year and wrote no receipts, so
            // every innocent mutation in the batch retried forever against a
            // request that could only ever 500. Refuse this one instead; the
            // original receipt already records what that id actually did.
            result.push({ mutationId: mutation.mutationId, applied: false });
            continue;
          }
          result.push({
            mutationId: mutation.mutationId,
            applied: Boolean(receipt.applied),
          });
          continue;
        }
        const entityField = entityFieldForTarget(
          mutation.kind === "scalar"
            ? { kind: "scalar", field: mutation.field }
            : mutation.kind === "benefit"
              ? {
                  kind: "benefit",
                  id: mutation.entityId,
                  ...(mutation.property === null
                    ? {}
                    : { property: mutation.property }),
                }
              : mutation.kind === "expense"
                ? {
                    kind: "expense",
                    id: mutation.entityId,
                    ...(mutation.property === null
                      ? {}
                      : { property: mutation.property }),
                  }
                : {
                    kind: "transaction",
                    id: mutation.entityId,
                    ...(mutation.property === null
                      ? {}
                      : { property: mutation.property }),
                  },
        );
        const newestVersion = latestVersionForField(mutation.field, versions);
        const baseMatches =
          mutation.baseVersion !== undefined &&
          canonicalJson(mutation.baseVersion) ===
            canonicalJson(newestVersion ?? null);
        const incoming = {
          updatedAt: normalizeClientTimestamp(
            mutation.updatedAt,
            new Date(receivedAt.getTime() - (yearMutations.length - index - 1)),
            newestVersion !== undefined &&
              (baseMatches ||
                (mutation.deliveryAfterMutationId !== undefined &&
                  mutation.deliveryAfterMutationId ===
                    newestVersion.mutationId))
              ? newestVersion.updatedAt
              : undefined,
          ),
          mutationId: mutation.mutationId,
        };
        let applied =
          baseMatches || isIncomingVersionNewer(incoming, newestVersion);

        if (applied) {
          // The projection is judged once, after the batch, never mid-batch: a
          // coupled save legitimately passes through invalid intermediate
          // states, so judging a mutation against a half-applied plan rejects
          // valid edits depending on delivery order. When the finished batch is
          // inadmissible, the culprits are identified from the finished
          // projection and refused by id on a second pass.
          if (refusedIds.has(mutation.mutationId)) {
            applied = false;
          } else if (mutation.kind !== "scalar") {
            try {
              // A savepoint bounds the blast radius of a constraint the client
              // payload violates: the failing statement rolls back alone and
              // still earns a receipt, so the outbox can drain.
              applied = await transaction.savepoint((savepoint) =>
                persistDecodedEntityMutation(savepoint, plan.id, mutation),
              );
            } catch (error) {
              if (!isRejectableMutationViolation(error)) throw error;
              applied = false;
            }
          }
          if (applied) {
            // `initialPlan` stays untouched for the refusal search; the
            // projection gets one private copy for the whole batch.
            if (projectedPlan === initialPlan)
              projectedPlan = structuredClone(initialPlan);
            applyDecodedSyncMutationInPlace(projectedPlan, mutation);
            appliedMutations.push(mutation);
            if (mutation.kind !== "scalar" && mutation.property === null) {
              for (const field of Object.keys(versions)) {
                const target = parseSyncTarget(field);
                if (target && field.startsWith(`${entityField}:`)) {
                  delete versions[syncFieldForTarget(target)];
                }
              }
            }
            versions[mutation.field] = incoming;
          }
        }
        receipts.push({
          mutation_id: mutation.mutationId,
          result: { applied, fingerprint },
        });
        result.push({ mutationId: mutation.mutationId, applied });
      }
      // `plans.updated_at` is the client's cache revision, so a batch that
      // applied nothing must not move it and invalidate every other device's
      // snapshot. Receipts are still written, so the outbox can drain.
      if (appliedMutations.length > 0) {
        await transaction`
          UPDATE plans
          SET state_code = ${projectedPlan.stateCode},
              filing_status = ${projectedPlan.filingStatus},
              gross_salary_cents = ${projectedPlan.grossSalaryCents},
              additional_income_cents = ${projectedPlan.additionalWageIncomeCents},
              spouse_wage_income_cents = ${projectedPlan.spouseWageIncomeCents},
              other_ordinary_income_cents = ${projectedPlan.otherOrdinaryIncomeCents},
              hsa_coverage = ${projectedPlan.hsaCoverage},
              primary_hsa_eligible = ${projectedPlan.primaryHsaEligible},
              spouse_hsa_eligible = ${projectedPlan.spouseHsaEligible},
              primary_hsa_catch_up_eligible = ${projectedPlan.primaryHsaCatchUpEligible},
              spouse_hsa_catch_up_eligible = ${projectedPlan.spouseHsaCatchUpEligible},
              primary_hsa_family_allocation_ppm = ${projectedPlan.primaryHsaFamilyAllocationPpm},
              spouse_hsa_family_allocation_ppm = ${projectedPlan.spouseHsaFamilyAllocationPpm},
              starting_savings_cents = ${projectedPlan.startingSavingsCents ?? null},
              field_versions = ${transaction.json(versionsJson(versions))},
              updated_at = now()
          WHERE id = ${plan.id}
        `;
      }
      if (receipts.length > 0) {
        await transaction`
          INSERT INTO applied_mutations (user_id, mutation_id, result)
          SELECT ${userId}, receipt.mutation_id, receipt.result
          FROM jsonb_to_recordset(
            ${transaction.typed(JSON.stringify(receipts), 25)}::jsonb
          ) AS receipt(mutation_id text, result jsonb)
        `;
      }
      if (!isAdmissibleProjection(projectedPlan))
        throw new InvalidFinalPlanError(
          refusableMutationIds(initialPlan, appliedMutations),
        );
      return result;
    });
    return { kind: "committed", acknowledgements };
  } catch (error) {
    if (
      !(error instanceof InvalidFinalPlanError) &&
      !isForeignKeyConstraintViolation(error)
    )
      throw error;
    const refusable =
      error instanceof InvalidFinalPlanError ? error.refusable : [];
    if (refusedIds.size === 0 && refusable.length > 0) {
      // Retry refusing exactly the edits responsible, so the rest commit and
      // every mutation earns a receipt. A year rejected without receipts can
      // never leave the client's outbox, and takes every later edit to that
      // year down with it.
      return reconcilePlanYear(
        sql,
        userId,
        planYear,
        yearMutations,
        receivedAt,
        new Set(refusable),
      );
    }
    return {
      kind: "rejected",
      acknowledgements: yearMutations.map(({ mutationId }) => ({
        mutationId,
        applied: false,
        rejected: true,
      })),
    };
  }
}

export async function applySyncMutations(
  sql: Sql,
  userId: string,
  rawMutations: unknown[],
) {
  const receivedAt = new Date();
  const acknowledgements: SyncAcknowledgement[] = [];
  const envelopesById = new Map<string, SyncMutation[]>();
  const invalidCanonicalIds = new Set<string>();
  for (const raw of rawMutations) {
    const parsed = syncMutationSchema.safeParse(raw);
    if (parsed.success) {
      const group = envelopesById.get(parsed.data.mutationId) ?? [];
      group.push(parsed.data);
      envelopesById.set(parsed.data.mutationId, group);
      continue;
    }
    const rawMutationId =
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { mutationId?: unknown }).mutationId === "string"
        ? String((raw as { mutationId: string }).mutationId)
        : "";
    const canonicalId = canonicalUuidSchema.safeParse(rawMutationId);
    const mutationId = canonicalId.success ? canonicalId.data : rawMutationId;
    if (canonicalId.success) invalidCanonicalIds.add(canonicalId.data);
    acknowledgements.push({ mutationId, applied: false, rejected: true });
  }
  const parsedMutations: DecodedSyncMutation[] = [];
  for (const [mutationId, envelopes] of envelopesById) {
    let decoded: DecodedSyncMutation[];
    try {
      decoded = envelopes.map((envelope) => decodeSyncMutation(envelope));
    } catch {
      decoded = [];
    }
    const fingerprints = new Set(
      decoded.map((mutation) =>
        syncIntentFingerprint(encodeSyncMutation(mutation)),
      ),
    );
    if (
      invalidCanonicalIds.has(mutationId) ||
      decoded.length !== envelopes.length ||
      fingerprints.size > 1 ||
      decoded.some((mutation) =>
        mutationUsesFutureActualDate(mutation, receivedAt),
      )
    ) {
      acknowledgements.push(
        ...envelopes.map(() => ({
          mutationId,
          applied: false as const,
          rejected: true as const,
        })),
      );
      continue;
    }
    parsedMutations.push(decoded[0]);
  }
  parsedMutations.sort(
    (left, right) =>
      Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
      left.mutationId.localeCompare(right.mutationId),
  );
  const byYear = new Map<number, DecodedSyncMutation[]>();
  for (const mutation of parsedMutations) {
    const group = byYear.get(mutation.planYear) ?? [];
    group.push(mutation);
    byYear.set(mutation.planYear, group);
  }

  for (const [planYear, yearMutations] of byYear) {
    const result = await reconcilePlanYear(
      sql,
      userId,
      planYear,
      yearMutations,
      receivedAt,
    );
    acknowledgements.push(...result.acknowledgements);
  }
  return { acknowledgements, plans: await listPlans(sql, userId) };
}
