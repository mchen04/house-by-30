import { storedPlanSchema } from "@/domain/plan-schema";
import { normalizeStoredPlan, type StoredPlan } from "@/domain/stored-plan";
import {
  applyDecodedSyncMutations,
  decodeSyncMutation,
} from "@/domain/sync-decoder";
import type { SyncMutation } from "@/domain/sync";
import {
  safelyCloseAccount as closeAccountLifecycle,
  type AccountClosureMode,
  type AccountClosureResult,
  type RemoteAccountClosureOutcome,
} from "./account-lifecycle";
import {
  accountDatabaseName,
  isMarkedLoggedOut,
  openDatabase,
  requestResult,
  transactionDone,
  withAccountLock,
  withIntentLock,
} from "./database-core";
import {
  addPreparedMutations,
  prepareMutations,
  queuedMutations,
  sequencedMutations,
} from "./outbox";
import {
  latestLocalSequenceForField,
  type SequencedSyncMutation,
} from "./queue-planner";

export {
  clearRememberedUser,
  lastRememberedUser,
  rememberUser,
  type AccountClosureMode,
  type AccountClosureResult,
  type RemoteAccountClosureOutcome,
} from "./account-lifecycle";
export { withCopyForwardIntentLock } from "./database-core";
export { clearAccountDatabase as clearAccountCache } from "./database-core";
export {
  compactedMutationBatch,
  enqueueMutations,
  queuedMutations,
  removeMutations,
} from "./outbox";
export {
  cachedPlans,
  cachePlansIfOutboxEmpty,
  restorableCachedPlans,
  startupPlanState,
  type StartupPlanState,
} from "./plan-cache";

export async function cachePlansAndEnqueue(
  userId: string,
  plans: StoredPlan[],
  mutations: SyncMutation[],
  ownerSignal?: AbortSignal,
): Promise<void> {
  const withOwnedIntentLock = <T>(operation: () => Promise<T>) =>
    withIntentLock(userId, operation, ownerSignal);
  const withOwnedAccountLock = <T>(operation: () => Promise<T>) =>
    withAccountLock(userId, operation, ownerSignal);
  return withOwnedIntentLock(() =>
    withOwnedAccountLock(async () => {
      if (await isMarkedLoggedOut(userId))
        throw new Error("This account was logged out in another tab.");
      const db = await openDatabase(accountDatabaseName(userId), [
        "plans",
        "outbox",
      ]);
      try {
        const transaction = db.transaction(["plans", "outbox"], "readwrite");
        const plansStore = transaction.objectStore("plans");
        const outboxStore = transaction.objectStore("outbox");
        try {
          const existingMutations = await sequencedMutations(outboxStore);
          const preparedMutations = prepareMutations(
            existingMutations,
            mutations,
          );
          const fallbackByYear = new Map(
            plans.map((plan) => [plan.year, plan]),
          );
          const byYear = new Map<number, SequencedSyncMutation[]>();
          for (const mutation of preparedMutations) {
            const group = byYear.get(mutation.planYear) ?? [];
            group.push(mutation);
            byYear.set(mutation.planYear, group);
          }
          for (const [year, yearMutations] of byYear) {
            const localSequences: Record<string, number> = {};
            for (const mutation of existingMutations
              .filter(({ planYear }) => planYear === year)
              .toSorted(
                (left, right) => left.localSequence - right.localSequence,
              )) {
              if (
                mutation.localSequence >
                latestLocalSequenceForField(mutation.field, localSequences)
              )
                localSequences[mutation.field] = mutation.localSequence;
            }
            const existingRow = await requestResult(plansStore.get(year));
            const existing =
              existingRow === undefined
                ? undefined
                : storedPlanSchema.parse(existingRow);
            const fallback = fallbackByYear.get(year);
            if (!existing && !fallback) continue;
            const winningMutations = yearMutations
              .toSorted(
                (left, right) => left.localSequence - right.localSequence,
              )
              .filter((mutation) => {
                if (
                  mutation.localSequence <=
                  latestLocalSequenceForField(mutation.field, localSequences)
                )
                  return false;
                localSequences[mutation.field] = mutation.localSequence;
                return true;
              });
            const merged = normalizeStoredPlan(
              applyDecodedSyncMutations(
                normalizeStoredPlan(existing ?? fallback!),
                winningMutations.map(decodeSyncMutation),
              ),
            );
            plansStore.put(merged);
          }
          addPreparedMutations(outboxStore, preparedMutations);
          await transactionDone(transaction);
        } catch (error) {
          transaction.abort();
          throw error;
        }
      } finally {
        db.close();
      }
    }),
  );
}

export async function safelyCloseAccount(
  userId: string,
  mode: AccountClosureMode,
  closeRemote: () => Promise<RemoteAccountClosureOutcome>,
  ownerSignal?: AbortSignal,
): Promise<AccountClosureResult> {
  return closeAccountLifecycle(
    userId,
    mode,
    closeRemote,
    async () => (await queuedMutations(userId)).length,
    ownerSignal,
  );
}
