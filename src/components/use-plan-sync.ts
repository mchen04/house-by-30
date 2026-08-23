import { useCallback, useEffect } from "react";
import {
  plansResponseSchema,
  syncResponseSchema,
  userResponseSchema,
  type User,
} from "@/domain/api-contracts";
import { storedPlanSchema } from "@/domain/plan-schema";
import { defaultPlanForToday } from "@/domain/plan-selection";
import { diffPlanMutations } from "@/domain/sync";
import {
  cachePlansAndEnqueue,
  cachePlansIfOutboxEmpty,
  compactedMutationBatch,
  queuedMutations,
  removeMutations,
  startupPlanState,
  type StartupPlanState,
} from "@/offline/database";
import {
  EXPIRED_SESSION_NOTICE,
  HttpError,
  isExpiredSessionError,
  jsonRequest,
  reconciliationFailureState,
  type SaveState,
  type StoredPlan,
} from "./plan-types";
import { recoverPlanCreationWithBackoff } from "./onboarding-recovery";
import {
  canPublishPlanSnapshot,
  cancelAccountPersistenceRetry,
  enqueueSerializedIntent,
  intentAwaitingDurableWrite,
  isCurrentAccountLifecycle,
  mergePlansWithLocalIntent,
  planIntentForYear,
  publishDurabilityGap,
  publishUndurableUnloadIntent,
  queueAccountPersistenceRetry,
  reconciliationCompletionState,
  reconciliationStateWithPersistencePriority,
  registerPlanWriteFailure,
  removableAcknowledgementIds,
  replacePlanIntent,
  resolvePlanWriteSuccess,
  runDevicePersistenceRetry,
  unflushedIntentMutations,
} from "./sync-state";
import { registerUnloadIntentFlush } from "./document-exit";
import { flushUnloadIntent } from "./unload-flush";
import {
  requireAuthoritativePlanRefresh,
  type PlanSessionController,
} from "./use-plan-session";

function resolveStartupPlans(
  serverPlans: StoredPlan[],
  startup: StartupPlanState,
): StoredPlan[] {
  return startup.pendingMutations.length > 0
    ? mergePlansWithLocalIntent(
        serverPlans,
        startup.cachedPlans,
        startup.pendingMutations,
      )
    : startup.cachedPlans;
}

export function usePlanSync(session: PlanSessionController) {
  const {
    user,
    draft,
    localSaveRetry,
    startupValidationPending,
    runtimeRef,
    getOwnerSignal,
    setDraft,
    setLocalSaveRetry,
    setPlans,
    setSaveState,
    invalidateSession,
  } = session;

  const queueDevicePersistenceRetry = useCallback(
    (accountId: string, generation: number, retry: () => Promise<void>) => {
      runtimeRef.current.devicePersistenceRetry = queueAccountPersistenceRetry(
        runtimeRef.current.devicePersistenceRetry,
        accountId,
        generation,
        retry,
        runtimeRef.current.activeAccount,
        runtimeRef.current.accountGeneration,
      );
      const pending = runtimeRef.current.devicePersistenceRetry;
      if (
        !pending ||
        !isCurrentAccountLifecycle(
          pending,
          runtimeRef.current.activeAccount,
          runtimeRef.current.accountGeneration,
        )
      )
        return;
      runtimeRef.current.retryablePersistenceFailure = true;
      setSaveState("local-error");
    },
    [runtimeRef, setSaveState],
  );

  const cancelDevicePersistenceRetry = useCallback(
    (accountId?: string) => {
      const next = cancelAccountPersistenceRetry(
        runtimeRef.current.devicePersistenceRetry,
        accountId,
      );
      if (next === runtimeRef.current.devicePersistenceRetry) return;
      runtimeRef.current.devicePersistenceRetry = next;
      runtimeRef.current.retryablePersistenceFailure = false;
    },
    [runtimeRef],
  );

  const loadPlansFor = useCallback(
    async (
      account: User,
      options: {
        selectedYear?: number;
        generation?: number;
        serverPlans?: StoredPlan[];
        signal?: AbortSignal;
      } = {},
    ) => {
      const generation =
        options.generation ?? runtimeRef.current.accountGeneration;
      const isCurrentAccount = () =>
        !options.signal?.aborted &&
        runtimeRef.current.activeAccount === account.id &&
        runtimeRef.current.accountGeneration === generation;
      if (!isCurrentAccount()) return;
      const loadRevision = ++runtimeRef.current.planLoadRevision;
      const intentRevision = runtimeRef.current.intentRevision;
      const response = options.serverPlans
        ? { plans: options.serverPlans }
        : await jsonRequest(
            "/api/plans",
            plansResponseSchema,
            { signal: options.signal },
            account.id,
          );
      let resolvedPlans = response.plans;
      const displayPlans = (nextPlans: StoredPlan[]) => {
        if (
          !isCurrentAccount() ||
          runtimeRef.current.planLoadRevision !== loadRevision ||
          !canPublishPlanSnapshot(
            intentRevision,
            runtimeRef.current.intentRevision,
            runtimeRef.current.durableIntentRevision,
          )
        )
          return;
        setPlans(nextPlans);
        runtimeRef.current.plans = nextPlans;
        setDraft(
          nextPlans.find(({ year }) => year === options.selectedYear) ??
            defaultPlanForToday(nextPlans),
        );
        runtimeRef.current.savedSnapshots = new Map(
          nextPlans.map((plan) => [plan.year, JSON.stringify(plan)]),
        );
      };
      if (!isCurrentAccount()) return;
      try {
        const startup = await startupPlanState(account.id, response.plans);
        if (!isCurrentAccount()) return;
        // A launch is the one moment the answer is knowable from scratch: a
        // parked edit this launch could not parse is lost, and anything an
        // earlier document reported undurable has either been carried into the
        // outbox by now or was never recoverable at all.
        //
        // Storage that refuses to park is the third case and the one that used
        // to slip through. The signal a dying document raised died with it, and
        // a launch that cannot read the journal cannot distinguish "the last
        // document parked nothing" from "the last document could not park what
        // it had". Only one of those is safe to render as `Saved`, so a session
        // with no durable parking space declines to make the claim until it has
        // watched a write of its own reach the device.
        publishUndurableUnloadIntent(
          startup.unreadableJournal || startup.parkingUnavailable,
        );
        resolvedPlans = resolveStartupPlans(response.plans, startup);
      } catch {
        if (!isCurrentAccount()) return;
        queueDevicePersistenceRetry(account.id, generation, async () => {
          if (!isCurrentAccount()) return;
          const startup = await startupPlanState(account.id, response.plans);
          if (!isCurrentAccount()) return;
          displayPlans(resolveStartupPlans(response.plans, startup));
        });
      }
      displayPlans(resolvedPlans);
    },
    [runtimeRef, queueDevicePersistenceRetry, setDraft, setPlans],
  );

  const reconcileFor = useCallback(
    async (account: User, forceRetry = false) => {
      if (runtimeRef.current.activeAccount !== account.id) return;
      if (runtimeRef.current.reconcileRunning) {
        runtimeRef.current.reconcileRequested = true;
        if (forceRetry) runtimeRef.current.reconcileAbortController?.abort();
        return runtimeRef.current.reconcileRunning;
      }
      const generation = runtimeRef.current.accountGeneration;
      const requestController = new AbortController();
      runtimeRef.current.reconcileAbortController = requestController;
      const isCurrentAccount = () =>
        runtimeRef.current.activeAccount === account.id &&
        runtimeRef.current.accountGeneration === generation;
      const setReconciliationState = (
        candidate: SaveState,
        syncRequestFailure = false,
      ) =>
        setSaveState(
          reconciliationStateWithPersistencePriority({
            candidate,
            volatileWriteFailure: runtimeRef.current.volatileWriteFailure,
            retryablePersistenceFailure:
              runtimeRef.current.retryablePersistenceFailure,
            reconciliationPersistenceFailure:
              runtimeRef.current.reconciliationPersistenceFailure,
            rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
            syncRequestFailure,
          }),
        );
      const publishReconciledPlans = async (
        serverPlans: StoredPlan[],
        intentRevision: number,
      ): Promise<boolean> => {
        if (
          !isCurrentAccount() ||
          !canPublishPlanSnapshot(
            intentRevision,
            runtimeRef.current.intentRevision,
            runtimeRef.current.durableIntentRevision,
          )
        )
          return false;
        runtimeRef.current.planRefreshNeeded = true;
        const reconciledPlans = await cachePlansIfOutboxEmpty(
          account.id,
          serverPlans,
        );
        if (
          !reconciledPlans ||
          !isCurrentAccount() ||
          !canPublishPlanSnapshot(
            intentRevision,
            runtimeRef.current.intentRevision,
            runtimeRef.current.durableIntentRevision,
          )
        )
          return false;
        runtimeRef.current.planLoadRevision += 1;
        runtimeRef.current.plans = reconciledPlans;
        runtimeRef.current.planRefreshNeeded = false;
        runtimeRef.current.reconciliationPersistenceFailure = false;
        setPlans(reconciledPlans);
        runtimeRef.current.savedSnapshots = new Map(
          reconciledPlans.map((plan) => [plan.year, JSON.stringify(plan)]),
        );
        runtimeRef.current.rejectedWriteFailure = false;
        setDraft(
          (current) =>
            reconciledPlans.find(({ year }) => year === current?.year) ??
            reconciledPlans.at(-1) ??
            null,
        );
        return true;
      };
      const run = (async () => {
        try {
          let didSync = false;
          let hadRejection = false;
          while (navigator.onLine) {
            if (!isCurrentAccount()) break;
            const queued = await queuedMutations(account.id);
            if (!isCurrentAccount()) break;
            if (queued.length === 0) {
              if (
                runtimeRef.current.planRefreshNeeded &&
                runtimeRef.current.intentRevision ===
                  runtimeRef.current.durableIntentRevision
              ) {
                didSync = true;
                const refreshRevision = runtimeRef.current.intentRevision;
                const fresh = await jsonRequest(
                  "/api/plans",
                  plansResponseSchema,
                  { signal: requestController.signal },
                  account.id,
                );
                if (
                  !(await publishReconciledPlans(fresh.plans, refreshRevision))
                )
                  continue;
              }
              break;
            }
            didSync = true;
            setReconciliationState("saving");
            const batch = await compactedMutationBatch(account.id);
            if (!isCurrentAccount()) break;
            const batchIntentRevision =
              runtimeRef.current.durableIntentRevision;
            if (batch.length === 0) {
              runtimeRef.current.reconciliationPersistenceFailure = true;
              setReconciliationState("local-error");
              break;
            }
            const response = await jsonRequest(
              "/api/sync",
              syncResponseSchema,
              {
                method: "POST",
                body: JSON.stringify({ mutations: batch }),
                signal: requestController.signal,
              },
              account.id,
            );
            const removableIds = removableAcknowledgementIds(
              response.acknowledgements,
            );
            await removeMutations(account.id, removableIds);
            if (removableIds.length > 0)
              runtimeRef.current.planRefreshNeeded = true;
            if (!isCurrentAccount()) break;
            hadRejection ||= response.acknowledgements.some(
              ({ rejected }) => rejected,
            );
            if (hadRejection) runtimeRef.current.rejectedWriteFailure = true;
            const remaining = await queuedMutations(account.id);
            if (!isCurrentAccount()) break;
            runtimeRef.current.reconciliationPersistenceFailure = false;
            if (hadRejection) break;
            if (remaining.length === 0) {
              await publishReconciledPlans(response.plans, batchIntentRevision);
            }
          }
          if (isCurrentAccount()) {
            if (didSync || runtimeRef.current.skipNextSessionValidation) {
              runtimeRef.current.skipNextSessionValidation = false;
            } else {
              await jsonRequest(
                "/api/auth/session",
                userResponseSchema,
                { signal: requestController.signal },
                account.id,
              );
            }
          }
          if (hadRejection && isCurrentAccount()) {
            setReconciliationState("rejected");
          } else if (isCurrentAccount()) {
            const queuedMutationCount = (await queuedMutations(account.id))
              .length;
            if (!isCurrentAccount()) return;
            if (
              runtimeRef.current.intentRevision !==
              runtimeRef.current.durableIntentRevision
            ) {
              setReconciliationState(navigator.onLine ? "saving" : "offline");
              return;
            }
            if (runtimeRef.current.planRefreshNeeded) {
              runtimeRef.current.reconcileRequested = true;
              setReconciliationState(navigator.onLine ? "saving" : "offline");
              return;
            }
            runtimeRef.current.reconciliationPersistenceFailure = false;
            setReconciliationState(
              reconciliationCompletionState({
                queuedMutationCount,
                volatileWriteFailure:
                  runtimeRef.current.volatileWriteFailure ||
                  runtimeRef.current.retryablePersistenceFailure ||
                  runtimeRef.current.reconciliationPersistenceFailure,
                rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
              }),
            );
          }
        } catch (error) {
          if (requestController.signal.aborted) {
            return;
          } else if (isCurrentAccount() && isExpiredSessionError(error)) {
            invalidateSession(EXPIRED_SESSION_NOTICE);
          } else if (
            isCurrentAccount() &&
            error instanceof HttpError &&
            error.status === 409
          ) {
            runtimeRef.current.devicePersistenceRetry = null;
            runtimeRef.current.retryablePersistenceFailure = false;
            invalidateSession(
              "The active account changed in another tab. Sign in again.",
            );
          } else if (isCurrentAccount()) {
            const failureState = reconciliationFailureState(error);
            if (failureState === "local-error")
              runtimeRef.current.reconciliationPersistenceFailure = true;
            setReconciliationState(failureState, failureState === "sync-error");
          }
        }
      })().finally(() => {
        if (
          runtimeRef.current.accountGeneration !== generation ||
          runtimeRef.current.reconcileRunning !== run
        )
          return;
        runtimeRef.current.reconcileRunning = null;
        if (runtimeRef.current.reconcileAbortController === requestController)
          runtimeRef.current.reconcileAbortController = null;
        if (runtimeRef.current.reconcileRequested && navigator.onLine) {
          runtimeRef.current.reconcileRequested = false;
          window.dispatchEvent(new Event("online"));
        }
      });
      runtimeRef.current.reconcileRunning = run;
      return run;
    },
    [invalidateSession, runtimeRef, setDraft, setPlans, setSaveState],
  );

  const persistPlanIntent = useCallback(
    (
      changedDraft: StoredPlan,
      account: User,
      generation = runtimeRef.current.accountGeneration,
    ): Promise<void> => {
      const snapshot = JSON.stringify(changedDraft);
      const accountId = account.id;
      const ownerSignal = getOwnerSignal();
      const intentRevision = runtimeRef.current.intentRevision;
      const write = enqueueSerializedIntent(
        runtimeRef.current.localWriteChain,
        snapshot,
        () => runtimeRef.current.savedSnapshots.get(changedDraft.year),
        async (priorSnapshot) => {
          if (
            runtimeRef.current.activeAccount !== accountId ||
            runtimeRef.current.accountGeneration !== generation
          )
            return;
          const previous = storedPlanSchema.parse(JSON.parse(priorSnapshot));
          const mutationTime = Math.max(
            Date.now(),
            runtimeRef.current.lastMutationTime + 1,
          );
          runtimeRef.current.lastMutationTime = mutationTime;
          const mutations = diffPlanMutations(
            previous,
            changedDraft,
            new Date(mutationTime).toISOString(),
          );
          const nextPlans = replacePlanIntent(
            runtimeRef.current.plans,
            changedDraft,
          );
          await cachePlansAndEnqueue(
            accountId,
            nextPlans,
            mutations,
            ownerSignal,
          );
        },
      );
      runtimeRef.current.localWriteChain = write
        .then((result) => {
          if (
            result === "missing-baseline" ||
            runtimeRef.current.activeAccount !== accountId ||
            runtimeRef.current.accountGeneration !== generation
          )
            return;
          if (result === "persisted") {
            runtimeRef.current.savedSnapshots.set(changedDraft.year, snapshot);
            // The device took the write, so whatever an earlier unload could
            // not park is now somewhere that survives this document after all.
            publishUndurableUnloadIntent(false);
          }
          if (
            runtimeRef.current.savedSnapshots.get(changedDraft.year) !==
            snapshot
          )
            return;
          const durability = resolvePlanWriteSuccess(
            runtimeRef.current.volatileWriteFailureYears,
            changedDraft.year,
            runtimeRef.current.durableIntentRevision,
            intentRevision,
          );
          runtimeRef.current.volatileWriteFailure =
            durability.volatileWriteFailure;
          runtimeRef.current.durableIntentRevision =
            durability.durableIntentRevision;
          if (runtimeRef.current.retryablePersistenceFailure) {
            setSaveState("local-error");
            return;
          }
          if (!navigator.onLine) {
            setSaveState(
              reconciliationStateWithPersistencePriority({
                candidate: "offline",
                volatileWriteFailure: runtimeRef.current.volatileWriteFailure,
                retryablePersistenceFailure:
                  runtimeRef.current.retryablePersistenceFailure,
                reconciliationPersistenceFailure:
                  runtimeRef.current.reconciliationPersistenceFailure,
                rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
              }),
            );
            return;
          }
          setSaveState(
            reconciliationStateWithPersistencePriority({
              candidate: "saving",
              volatileWriteFailure: runtimeRef.current.volatileWriteFailure,
              retryablePersistenceFailure:
                runtimeRef.current.retryablePersistenceFailure,
              reconciliationPersistenceFailure:
                runtimeRef.current.reconciliationPersistenceFailure,
              rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
            }),
          );
          window.clearTimeout(runtimeRef.current.syncTimer);
          runtimeRef.current.syncTimer = window.setTimeout(
            () => void reconcileFor(account),
            650,
          );
        })
        .catch(() => {
          if (
            runtimeRef.current.activeAccount === accountId &&
            runtimeRef.current.accountGeneration === generation
          ) {
            registerPlanWriteFailure(
              runtimeRef.current.volatileWriteFailureYears,
              changedDraft.year,
            );
            runtimeRef.current.volatileWriteFailure = true;
            setSaveState("local-error");
          }
        });
      return runtimeRef.current.localWriteChain;
    },
    [getOwnerSignal, reconcileFor, runtimeRef, setSaveState],
  );

  /**
   * The last thing this document does. `document-exit` has just committed every
   * open buffer, so `runtimeRef.current.plans` — written synchronously by the
   * draft handler, not by a React render — already holds the reader's finished
   * edit while nothing downstream of it has run.
   *
   * Everything the ordinary path would do next is asynchronous and therefore
   * already lost: the Web Locks, the IndexedDB transaction, the 650 ms debounce.
   * `keepalive` is the one way out that does not need the document to survive —
   * the request is handed to the browser's network stack and completes after the
   * page is gone. It is fire-and-forget by nature: there is no one left to read
   * the response, and the reload that follows re-reads the plan from the server
   * anyway.
   *
   * Re-sending is safe. A mutation is keyed by its own id and judged by field
   * version, so a duplicate the outbox drains later is simply not applied — it
   * is acknowledged, not rejected, and no banner follows it.
   */
  const flushIntentBeforeUnload = useCallback(() => {
    const accountId = runtimeRef.current.activeAccount;
    if (!accountId) return;
    const mutationTime = Math.max(
      Date.now(),
      runtimeRef.current.lastMutationTime + 1,
    );
    const mutations = unflushedIntentMutations(
      runtimeRef.current.plans,
      runtimeRef.current.savedSnapshots,
      new Date(mutationTime).toISOString(),
    );
    if (mutations.length === 0) return;
    runtimeRef.current.lastMutationTime = mutationTime;
    flushUnloadIntent(accountId, mutations);
  }, [runtimeRef]);

  useEffect(
    () => registerUnloadIntentFlush(flushIntentBeforeUnload),
    [flushIntentBeforeUnload],
  );

  // No dependency list on purpose. Both sides of this comparison live on the
  // runtime ref, which React cannot watch; what it can watch is that every
  // write to either of them is paired with a dispatch, so a render is the
  // reliable signal that the answer may have changed.
  useEffect(() =>
    publishDurabilityGap(
      intentAwaitingDurableWrite(
        runtimeRef.current.plans,
        runtimeRef.current.savedSnapshots,
      ),
    ),
  );

  const adoptCreatedPlan = useCallback(
    async (
      account: User,
      plan: StoredPlan,
      generation = runtimeRef.current.accountGeneration,
      ownerSignal?: AbortSignal,
    ) => {
      if (ownerSignal?.aborted) return;
      await loadPlansFor(account, {
        selectedYear: plan.year,
        generation,
        serverPlans: [plan],
      });
      if (
        runtimeRef.current.activeAccount !== account.id ||
        runtimeRef.current.accountGeneration !== generation ||
        ownerSignal?.aborted
      )
        return;
      requireAuthoritativePlanRefresh(runtimeRef.current);
      setSaveState(
        reconciliationStateWithPersistencePriority({
          candidate: navigator.onLine ? "saving" : "offline",
          volatileWriteFailure: runtimeRef.current.volatileWriteFailure,
          retryablePersistenceFailure:
            runtimeRef.current.retryablePersistenceFailure,
          reconciliationPersistenceFailure:
            runtimeRef.current.reconciliationPersistenceFailure,
          rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
        }),
      );
      if (navigator.onLine) void reconcileFor(account);
    },
    [loadPlansFor, reconcileFor, runtimeRef, setSaveState],
  );

  const recoverCreatedPlan = useCallback(
    async (
      account: User,
      selectedYear: number,
      generation = runtimeRef.current.accountGeneration,
      ownerSignal?: AbortSignal,
    ): Promise<boolean> => {
      const isCurrentAccount = () =>
        runtimeRef.current.activeAccount === account.id &&
        runtimeRef.current.accountGeneration === generation &&
        !ownerSignal?.aborted;
      let recoveredPlans: StoredPlan[] | undefined;
      const recovered = await recoverPlanCreationWithBackoff(
        async (year, signal) => {
          if (!isCurrentAccount()) return false;
          const response = await jsonRequest(
            "/api/plans",
            plansResponseSchema,
            { signal },
            account.id,
          );
          if (!isCurrentAccount()) return false;
          if (!response.plans.some((plan) => plan.year === year)) return false;
          recoveredPlans = response.plans;
          return true;
        },
        selectedYear,
        { ownerSignal },
      );
      if (!recovered || !recoveredPlans || !isCurrentAccount()) return false;
      await loadPlansFor(account, {
        selectedYear,
        generation,
        serverPlans: recoveredPlans,
      });
      return (
        isCurrentAccount() &&
        runtimeRef.current.plans.some(({ year }) => year === selectedYear)
      );
    },
    [loadPlansFor, runtimeRef],
  );

  const retrySync = useCallback(async () => {
    if (user) await reconcileFor(user, true);
  }, [reconcileFor, user]);

  const retryDeviceSave = useCallback(async () => {
    const pending = runtimeRef.current.devicePersistenceRetry;
    const accountId = user?.id;
    const generation = runtimeRef.current.accountGeneration;
    const retry =
      pending &&
      isCurrentAccountLifecycle(
        pending,
        runtimeRef.current.activeAccount,
        runtimeRef.current.accountGeneration,
      ) &&
      pending.accountId === user?.id
        ? pending.retry
        : null;
    if (pending && !retry) cancelDevicePersistenceRetry();
    try {
      await runDevicePersistenceRetry(retry, async () => {
        if (
          !user ||
          runtimeRef.current.activeAccount !== accountId ||
          runtimeRef.current.accountGeneration !== generation
        )
          return;
        const failedPlanYears = [
          ...runtimeRef.current.volatileWriteFailureYears,
        ];
        if (failedPlanYears.length === 0) {
          setLocalSaveRetry((attempt) => attempt + 1);
          return;
        }
        for (const year of failedPlanYears) {
          if (
            runtimeRef.current.activeAccount !== accountId ||
            runtimeRef.current.accountGeneration !== generation
          )
            return;
          const plan = planIntentForYear(runtimeRef.current.plans, year);
          if (plan) await persistPlanIntent(plan, user, generation);
        }
      });
      if (
        !accountId ||
        runtimeRef.current.activeAccount !== accountId ||
        runtimeRef.current.accountGeneration !== generation
      )
        return;
      if (
        pending &&
        !isCurrentAccountLifecycle(
          pending,
          runtimeRef.current.activeAccount,
          runtimeRef.current.accountGeneration,
        )
      )
        return;
      if (runtimeRef.current.devicePersistenceRetry === pending) {
        runtimeRef.current.devicePersistenceRetry = null;
        runtimeRef.current.retryablePersistenceFailure = false;
      }
      if (navigator.onLine && user) await reconcileFor(user);
      else
        setSaveState(
          reconciliationStateWithPersistencePriority({
            candidate: "offline",
            volatileWriteFailure: runtimeRef.current.volatileWriteFailure,
            retryablePersistenceFailure:
              runtimeRef.current.retryablePersistenceFailure,
            reconciliationPersistenceFailure:
              runtimeRef.current.reconciliationPersistenceFailure,
            rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
          }),
        );
    } catch {
      if (
        !pending ||
        !isCurrentAccountLifecycle(
          pending,
          runtimeRef.current.activeAccount,
          runtimeRef.current.accountGeneration,
        )
      )
        return;
      runtimeRef.current.retryablePersistenceFailure = true;
      setSaveState("local-error");
    }
  }, [
    runtimeRef,
    cancelDevicePersistenceRetry,
    persistPlanIntent,
    reconcileFor,
    setLocalSaveRetry,
    setSaveState,
    user,
  ]);

  useEffect(() => {
    if (!user || startupValidationPending) return;
    const onOnline = () => void reconcileFor(user);
    window.addEventListener("online", onOnline);
    if (navigator.onLine) void reconcileFor(user);
    return () => window.removeEventListener("online", onOnline);
  }, [reconcileFor, startupValidationPending, user]);

  useEffect(() => {
    if (!draft || !user) return;
    void persistPlanIntent(draft, user);
  }, [draft, localSaveRetry, persistPlanIntent, user]);

  return {
    adoptCreatedPlan,
    cancelDevicePersistenceRetry,
    loadPlansFor,
    queueDevicePersistenceRetry,
    reconcileFor,
    recoverCreatedPlan,
    retryDeviceSave,
    retrySync,
  };
}

export type PlanSyncController = ReturnType<typeof usePlanSync>;
