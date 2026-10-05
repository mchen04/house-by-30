import { useCallback, useEffect, useRef } from "react";
import {
  bootstrapResponseSchema,
  planResponseSchema,
  type User,
} from "@/domain/api-contracts";
import { storedPlanSchema } from "@/domain/plan-schema";
import { defaultPlanForToday } from "@/domain/plan-selection";
import {
  cacheOwnerStatus,
  forgetBrowserCacheOwner,
  rememberBrowserCacheOwner,
  type CacheOwnerStatus,
} from "@/offline/cache-owner";
import {
  lastRememberedUser,
  queuedMutations,
  rememberUser,
  restorableCachedPlans,
  safelyCloseAccount,
  withCopyForwardIntentLock,
  type AccountClosureMode,
} from "@/offline/database";
import { HttpError, jsonRequest, type StoredPlan } from "./plan-types";
import {
  authenticationBroadcastTransition,
  copyForwardIntentSnapshot,
  durableLogoutProblem,
  isCurrentAccountOperation,
  planIntentForYear,
  prepareCopyForward,
  serializedPlan,
  shouldEvictAccount,
  userWithLatestSession,
} from "./sync-state";
import {
  requireAuthoritativePlanRefresh,
  type PlanSessionController,
} from "./use-plan-session";
import type { PlanSyncController } from "./use-plan-sync";
import { requestRemoteAccountClosure } from "./account-closure";

function linkAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return { signal, abort };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, abort } of listeners)
        signal.removeEventListener("abort", abort);
    },
  };
}

interface CachedLaunch {
  user: User;
  plans: StoredPlan[];
  owner: CacheOwnerStatus;
}

function sameUser(left: User, right: User): boolean {
  return (
    left.id === right.id &&
    left.email === right.email &&
    left.sessionId === right.sessionId
  );
}

async function cachedLaunch(): Promise<CachedLaunch | null> {
  const user = await lastRememberedUser();
  if (!user) return null;
  const owner = cacheOwnerStatus(user);
  if (owner === "mismatch") return { user, plans: [], owner };
  return {
    user,
    plans: (await restorableCachedPlans(user.id)) ?? [],
    owner,
  };
}

export function useAccountLifecycle(
  session: PlanSessionController,
  sync: PlanSyncController,
) {
  const {
    user,
    draft,
    runtimeRef,
    beginAccount,
    getOwnerSignal,
    invalidateSession,
    markPlanAwaitingAuthority,
    setDraft,
    setLoading,
    setPlans,
    setSaveState,
    setStartupValidationPending,
    setUser,
  } = session;
  const {
    cancelDevicePersistenceRetry,
    loadPlansFor,
    queueDevicePersistenceRetry,
    reconcileFor,
  } = sync;
  const closeAccountInFlight = useRef<{
    mode: AccountClosureMode;
    promise: Promise<void>;
  } | null>(null);
  const latestSessionRef = useRef<{
    userId: string;
    sessionId: string;
  } | null>(null);
  const closeOwnerRef = useRef(new AbortController());
  const replaceCloseOwner = useCallback(() => {
    closeOwnerRef.current.abort(
      new DOMException(
        "A newer authentication replaced this request.",
        "AbortError",
      ),
    );
    closeOwnerRef.current = new AbortController();
  }, []);

  useEffect(() => {
    if (closeOwnerRef.current.signal.aborted)
      closeOwnerRef.current = new AbortController();
    return () => closeOwnerRef.current.abort();
  }, []);

  useEffect(() => {
    const requestController = new AbortController();
    let ownerSignal = getOwnerSignal();
    void (async () => {
      const startupGeneration = runtimeRef.current.accountGeneration;
      let ownedGeneration = startupGeneration;
      let restored: CachedLaunch | null = null;
      const cacheResult = cachedLaunch().then(
        (value) => ({ success: true as const, value }),
        (error: unknown) => ({ success: false as const, error }),
      );
      const bootstrapResult = jsonRequest(
        "/api/bootstrap",
        bootstrapResponseSchema,
        { signal: requestController.signal },
      ).then(
        (value) => ({ success: true as const, value }),
        (error: unknown) => ({ success: false as const, error }),
      );

      const restore = (
        candidate: CachedLaunch | null,
        allowMissingOwner: boolean,
        validationPending: boolean,
      ): boolean => {
        if (
          !candidate ||
          candidate.plans.length === 0 ||
          candidate.owner === "mismatch" ||
          (candidate.owner === "missing" && !allowMissingOwner) ||
          runtimeRef.current.accountGeneration !== ownedGeneration
        )
          return false;
        const generation = beginAccount(candidate.user.id, ownerSignal);
        if (generation === null) return false;
        ownedGeneration = generation;
        ownerSignal = getOwnerSignal();
        runtimeRef.current.startupValidationPending = validationPending;
        setStartupValidationPending(validationPending);
        runtimeRef.current.restoringAccount = candidate.user.id;
        setPlans(candidate.plans);
        runtimeRef.current.plans = candidate.plans;
        setDraft(defaultPlanForToday(candidate.plans));
        runtimeRef.current.savedSnapshots = new Map(
          candidate.plans.map((plan) => [plan.year, serializedPlan(plan)]),
        );
        runtimeRef.current.savedSnapshotPlans = new Map(
          candidate.plans.map((plan) => [plan.year, plan]),
        );
        requireAuthoritativePlanRefresh(runtimeRef.current);
        setSaveState("offline");
        setUser(
          userWithLatestSession(candidate.user, latestSessionRef.current),
        );
        if (navigator.onLine) markPlanAwaitingAuthority();
        if (candidate.owner === "missing")
          rememberBrowserCacheOwner(candidate.user);
        setLoading(false);
        restored = candidate;
        return true;
      };

      try {
        const first = await Promise.race([
          cacheResult.then((result) => ({ source: "cache" as const, result })),
          bootstrapResult.then((result) => ({
            source: "server" as const,
            result,
          })),
        ]);
        if (
          first.source === "cache" &&
          first.result.success &&
          first.result.value?.owner === "match"
        )
          restore(first.result.value, false, true);

        const bootstrap =
          first.source === "server" ? first.result : await bootstrapResult;
        if (!bootstrap.success) throw bootstrap.error;
        if (
          runtimeRef.current.accountGeneration !== ownedGeneration ||
          requestController.signal.aborted
        )
          return;

        const response = bootstrap.value;
        latestSessionRef.current = {
          userId: response.user.id,
          sessionId: response.user.sessionId,
        };
        rememberBrowserCacheOwner(response.user);
        let canRestore = true;
        let retryRememberUser = false;
        try {
          canRestore = await rememberUser(response.user, false, ownerSignal);
        } catch {
          if (runtimeRef.current.accountGeneration !== ownedGeneration) return;
          retryRememberUser = true;
        }
        if (
          runtimeRef.current.accountGeneration !== ownedGeneration ||
          requestController.signal.aborted
        )
          return;
        if (!canRestore) {
          forgetBrowserCacheOwner(response.user.sessionId);
          invalidateSession("");
          ownedGeneration = runtimeRef.current.accountGeneration;
          return;
        }

        const restoredSnapshot = restored as CachedLaunch | null;
        const restoredIdentityMatches =
          restoredSnapshot?.user.id === response.user.id &&
          restoredSnapshot.user.sessionId === response.user.sessionId;
        let generation = ownedGeneration;
        if (!restoredIdentityMatches) {
          if (restoredSnapshot) setLoading(true);
          const nextGeneration = beginAccount(response.user.id, ownerSignal);
          if (nextGeneration === null) return;
          generation = nextGeneration;
          ownedGeneration = generation;
          ownerSignal = getOwnerSignal();
        }
        runtimeRef.current.startupValidationPending = false;
        setStartupValidationPending(false);
        runtimeRef.current.skipNextSessionValidation = true;
        runtimeRef.current.planRefreshNeeded = false;
        if (retryRememberUser)
          queueDevicePersistenceRetry(
            response.user.id,
            generation,
            async () => {
              if (
                runtimeRef.current.activeAccount !== response.user.id ||
                runtimeRef.current.accountGeneration !== generation
              )
                return;
              if (!(await rememberUser(response.user, false, ownerSignal)))
                throw new Error("This account is no longer available offline.");
            },
          );
        await loadPlansFor(response.user, {
          generation,
          serverPlans: response.plans,
          serverPlanRevisions: response.planRevisions,
          signal: ownerSignal,
        });
        runtimeRef.current.restoringAccount = null;
        if (
          !ownerSignal.aborted &&
          runtimeRef.current.activeAccount === response.user.id &&
          runtimeRef.current.accountGeneration === generation
        ) {
          const nextUser = userWithLatestSession(
            response.user,
            latestSessionRef.current,
          );
          if (!restoredSnapshot || !sameUser(restoredSnapshot.user, nextUser))
            setUser(nextUser);
        }
      } catch (error) {
        if (
          runtimeRef.current.accountGeneration !== ownedGeneration ||
          requestController.signal.aborted
        )
          return;
        runtimeRef.current.startupValidationPending = false;
        setStartupValidationPending(false);
        if (error instanceof HttpError && error.status === 409) {
          cancelDevicePersistenceRetry();
          invalidateSession(
            "The active account changed in another tab. Sign in again.",
          );
          ownedGeneration = runtimeRef.current.accountGeneration;
        } else if (error instanceof HttpError && error.status === 401) {
          const cached = restored as CachedLaunch | null;
          if (cached?.user.sessionId)
            forgetBrowserCacheOwner(cached.user.sessionId);
          invalidateSession("");
          ownedGeneration = runtimeRef.current.accountGeneration;
        } else {
          if (!restored) {
            const cached = await cacheResult;
            if (!cached.success) setSaveState("local-error");
            else restore(cached.value, true, false);
          }
          if (restored) {
            setSaveState("offline");
            if (navigator.onLine) markPlanAwaitingAuthority();
          } else {
            invalidateSession("");
            ownedGeneration = runtimeRef.current.accountGeneration;
          }
          runtimeRef.current.restoringAccount = null;
        }
      } finally {
        if (
          runtimeRef.current.accountGeneration === ownedGeneration &&
          !requestController.signal.aborted
        )
          setLoading(false);
      }
    })();
    return () => requestController.abort();
  }, [
    runtimeRef,
    beginAccount,
    getOwnerSignal,
    cancelDevicePersistenceRetry,
    invalidateSession,
    loadPlansFor,
    markPlanAwaitingAuthority,
    queueDevicePersistenceRetry,
    setDraft,
    setLoading,
    setPlans,
    setSaveState,
    setStartupValidationPending,
    setUser,
  ]);

  useEffect(() => {
    const onAccountChange = () => {
      cancelDevicePersistenceRetry();
      invalidateSession(
        "The active account changed in another tab. Sign in again.",
      );
    };
    window.addEventListener("kyle-financial-account-change", onAccountChange);
    return () =>
      window.removeEventListener(
        "kyle-financial-account-change",
        onAccountChange,
      );
  }, [cancelDevicePersistenceRetry, invalidateSession]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("kyle-financial-auth");
    channel.onmessage = ({ data }) => {
      if (data?.type === "authenticated") {
        const transition = authenticationBroadcastTransition(
          runtimeRef.current.activeAccount,
          user,
          data,
          replaceCloseOwner,
        );
        if (transition.sessionIdentity)
          latestSessionRef.current = transition.sessionIdentity;
        if (!transition.invalidate) {
          if (transition.user !== user) setUser(transition.user);
          return;
        }
        cancelDevicePersistenceRetry();
        invalidateSession("The active account changed in another tab.");
        window.location.reload();
        return;
      }
      if (
        data?.type !== "logout" ||
        !shouldEvictAccount(
          runtimeRef.current.activeAccount,
          runtimeRef.current.restoringAccount,
          data.userId,
        )
      )
        return;
      cancelDevicePersistenceRetry(data.userId);
      invalidateSession("");
    };
    return () => channel.close();
  }, [
    runtimeRef,
    cancelDevicePersistenceRetry,
    invalidateSession,
    replaceCloseOwner,
    setUser,
    user,
  ]);

  const authenticate = useCallback(
    (nextUser: User, submissionSignal: AbortSignal) => {
      if (submissionSignal.aborted) return;
      if (nextUser.sessionId)
        latestSessionRef.current = {
          userId: nextUser.id,
          sessionId: nextUser.sessionId,
        };
      rememberBrowserCacheOwner(nextUser);
      replaceCloseOwner();
      const generation = beginAccount(nextUser.id, submissionSignal);
      if (generation === null) return;
      const ownerSignal = getOwnerSignal();
      cancelDevicePersistenceRetry();
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("kyle-financial-auth");
        channel.postMessage({
          type: "authenticated",
          userId: nextUser.id,
          sessionId: nextUser.sessionId,
        });
        channel.close();
      }
      setLoading(true);
      void (async () => {
        try {
          await rememberUser(nextUser, true, ownerSignal);
        } catch {
          if (ownerSignal.aborted) return;
          queueDevicePersistenceRetry(nextUser.id, generation, async () => {
            if (
              runtimeRef.current.activeAccount !== nextUser.id ||
              runtimeRef.current.accountGeneration !== generation
            )
              return;
            await rememberUser(nextUser, true, ownerSignal);
          });
        }
        if (
          ownerSignal.aborted ||
          runtimeRef.current.activeAccount !== nextUser.id ||
          runtimeRef.current.accountGeneration !== generation
        )
          return;
        await loadPlansFor(nextUser, { generation, signal: ownerSignal });
        if (
          !ownerSignal.aborted &&
          runtimeRef.current.activeAccount === nextUser.id &&
          runtimeRef.current.accountGeneration === generation
        )
          setUser(userWithLatestSession(nextUser, latestSessionRef.current));
      })()
        .catch((error) => {
          if (
            !ownerSignal.aborted &&
            runtimeRef.current.activeAccount === nextUser.id &&
            runtimeRef.current.accountGeneration === generation &&
            !(error instanceof HttpError && error.status === 409)
          ) {
            invalidateSession("Your plans could not be loaded. Try again.");
            setSaveState("sync-error");
          }
        })
        .finally(() => {
          if (
            !ownerSignal.aborted &&
            runtimeRef.current.activeAccount === nextUser.id &&
            runtimeRef.current.accountGeneration === generation
          )
            setLoading(false);
        });
    },
    [
      runtimeRef,
      beginAccount,
      getOwnerSignal,
      cancelDevicePersistenceRetry,
      invalidateSession,
      loadPlansFor,
      queueDevicePersistenceRetry,
      replaceCloseOwner,
      setLoading,
      setSaveState,
      setUser,
    ],
  );

  const closeAccount = useCallback(
    (deleteRemote: boolean): Promise<void> => {
      const mode: AccountClosureMode = deleteRemote ? "delete" : "logout";
      if (closeAccountInFlight.current) {
        if (closeAccountInFlight.current.mode === mode)
          return closeAccountInFlight.current.promise;
        return Promise.reject(
          new Error("Another account action is already in progress."),
        );
      }
      if (!user || !draft) return Promise.resolve();
      const closingUser = userWithLatestSession(user, latestSessionRef.current);
      const ownerSignal = getOwnerSignal();
      const linkedLockSignal = linkAbortSignals([
        ownerSignal,
        closeOwnerRef.current.signal,
      ]);
      const operation = (async () => {
        window.clearTimeout(runtimeRef.current.syncTimer);
        await runtimeRef.current.localWriteChain;
        ownerSignal.throwIfAborted();
        const durability = () =>
          durableLogoutProblem({
            draftSnapshot: JSON.stringify(draft),
            durableSnapshot: runtimeRef.current.savedSnapshots.get(draft.year),
            volatileWriteFailure:
              runtimeRef.current.volatileWriteFailure ||
              runtimeRef.current.retryablePersistenceFailure ||
              runtimeRef.current.reconciliationPersistenceFailure,
            rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
          });
        const localProblem = durability();
        if (localProblem) throw new Error(localProblem);
        if (navigator.onLine) await reconcileFor(closingUser);
        ownerSignal.throwIfAborted();
        const postSyncProblem = durability();
        if (postSyncProblem) throw new Error(postSyncProblem);
        const closure = await safelyCloseAccount(
          closingUser.id,
          mode,
          () => requestRemoteAccountClosure(closingUser, mode, ownerSignal),
          linkedLockSignal.signal,
        );
        if (closingUser.sessionId)
          forgetBrowserCacheOwner(closingUser.sessionId);
        cancelDevicePersistenceRetry(closingUser.id);
        const notice =
          closure.remoteStatus === "indeterminate"
            ? deleteRemote
              ? "Account deletion could not be confirmed. This browser cleared and locked its local copy; sign in again to verify or retry."
              : "The server response could not be confirmed, but this browser cleared its local copy and is safely logged out."
            : closure.cleanupComplete
              ? deleteRemote
                ? "Your account and every server plan were permanently deleted."
                : ""
              : deleteRemote
                ? "Your server account was deleted, but this browser could not finish clearing every cached record."
                : "You are logged out and this account is locked locally, but the browser could not finish deleting every cached record.";
        invalidateSession(notice);
      })();
      const inFlight = { mode, promise: operation };
      closeAccountInFlight.current = inFlight;
      void operation.then(
        () => {
          linkedLockSignal.dispose();
          if (closeAccountInFlight.current === inFlight)
            closeAccountInFlight.current = null;
        },
        () => {
          linkedLockSignal.dispose();
          if (closeAccountInFlight.current === inFlight)
            closeAccountInFlight.current = null;
        },
      );
      return operation;
    },
    [
      user,
      draft,
      runtimeRef,
      getOwnerSignal,
      cancelDevicePersistenceRetry,
      invalidateSession,
      reconcileFor,
    ],
  );

  const copyForward = useCallback(
    async (sourcePlan: StoredPlan, targetYear: number) => {
      if (!user) return;
      const accountGeneration = runtimeRef.current.accountGeneration;
      const ownerSignal = getOwnerSignal();
      const isCurrentAccount = () =>
        isCurrentAccountOperation(
          user.id,
          accountGeneration,
          ownerSignal,
          runtimeRef.current,
        );
      const requireCurrentAccount = () => {
        if (!isCurrentAccount())
          throw new DOMException("The account session changed.", "AbortError");
      };
      requireCurrentAccount();
      window.clearTimeout(runtimeRef.current.syncTimer);
      await runtimeRef.current.localWriteChain;
      requireCurrentAccount();
      const durabilityProblem = () => {
        requireCurrentAccount();
        return durableLogoutProblem({
          draftSnapshot: copyForwardIntentSnapshot(sourcePlan),
          durableSnapshot: (() => {
            const snapshot = runtimeRef.current.savedSnapshots.get(
              sourcePlan.year,
            );
            return snapshot
              ? copyForwardIntentSnapshot(
                  storedPlanSchema.parse(JSON.parse(snapshot)),
                )
              : undefined;
          })(),
          volatileWriteFailure:
            runtimeRef.current.volatileWriteFailure ||
            runtimeRef.current.retryablePersistenceFailure ||
            runtimeRef.current.reconciliationPersistenceFailure,
          rejectedWriteFailure: runtimeRef.current.rejectedWriteFailure,
        });
      };
      await withCopyForwardIntentLock(
        user.id,
        async () => {
          requireCurrentAccount();
          await prepareCopyForward({
            localWrites: Promise.resolve(),
            durabilityProblem,
            reconcile: async () => {
              requireCurrentAccount();
              await reconcileFor(user);
              requireCurrentAccount();
            },
            queuedMutationCount: async () => {
              requireCurrentAccount();
              const count = (await queuedMutations(user.id)).length;
              requireCurrentAccount();
              return count;
            },
          });
          requireCurrentAccount();
          const reconciledSource = planIntentForYear(
            runtimeRef.current.plans,
            sourcePlan.year,
          );
          if (!reconciledSource)
            throw new Error("The source plan is no longer available.");
          await jsonRequest(
            "/api/plans/copy",
            planResponseSchema,
            {
              method: "POST",
              body: JSON.stringify({
                sourceYear: sourcePlan.year,
                targetYear,
                expectedSourceUpdatedAt: reconciledSource.updatedAt,
                expectedSourceFieldVersions: reconciledSource.fieldVersions,
              }),
              signal: ownerSignal,
            },
            user.id,
          );
          requireCurrentAccount();
        },
        ownerSignal,
      );
      requireCurrentAccount();
      await loadPlansFor(user, {
        selectedYear: targetYear,
        generation: accountGeneration,
        signal: ownerSignal,
      });
    },
    [user, runtimeRef, getOwnerSignal, loadPlansFor, reconcileFor],
  );

  return { authenticate, closeAccount, copyForward };
}
