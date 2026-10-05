import { describe, expect, it } from "vitest";
import {
  beginOwnedPlanSessionRuntime,
  disposePlanSessionRuntime,
  requireAuthoritativePlanRefresh,
  transitionPlanSessionRuntime,
  type PlanSessionRuntime,
} from "./use-plan-session";
import { storedPlan } from "@/test/fixtures/plans";

function dirtyRuntime(): PlanSessionRuntime {
  return {
    savedSnapshots: new Map([[2026, "old account"]]),
    savedSnapshotPlans: new Map([[2026, storedPlan(2026)]]),
    confirmedPlans: new Map([
      [2026, { revision: "old-account", plan: storedPlan(2026) }],
    ]),
    plans: [],
    activeAccount: "account-a",
    accountGeneration: 4,
    ownerController: new AbortController(),
    planLoadRevision: 8,
    intentRevision: 9,
    durableIntentRevision: 7,
    localWriteChain: Promise.reject(new Error("old write")).catch(
      () => undefined,
    ),
    reconcileRunning: Promise.resolve(),
    reconcileAbortController: new AbortController(),
    reconcileRequested: true,
    planRefreshNeeded: true,
    reconciliationPersistenceFailure: true,
    syncTimer: undefined,
    lastMutationTime: 100,
    volatileWriteFailureYears: new Set([2026]),
    volatileWriteFailure: true,
    retryablePersistenceFailure: true,
    devicePersistenceRetry: {
      accountId: "account-a",
      generation: 4,
      retry: async () => undefined,
    },
    rejectedWriteFailure: true,
    restoringAccount: "account-a",
    startupValidationPending: false,
    skipNextSessionValidation: false,
  };
}

describe("account runtime transitions", () => {
  it("requires a server refresh before an offline-restored snapshot can be Saved", () => {
    const runtime = dirtyRuntime();
    runtime.planRefreshNeeded = false;

    requireAuthoritativePlanRefresh(runtime);

    expect(runtime.planRefreshNeeded).toBe(true);
  });

  it("does not leak failure or orchestration state into the next account", async () => {
    const runtime = dirtyRuntime();
    const priorReconciliation = runtime.reconcileAbortController;
    const priorOwner = runtime.ownerController;

    expect(transitionPlanSessionRuntime(runtime, "account-b")).toBe(5);
    expect(priorReconciliation?.signal.aborted).toBe(true);
    expect(priorOwner.signal.aborted).toBe(true);
    expect(runtime.ownerController.signal.aborted).toBe(false);

    expect(runtime).toMatchObject({
      activeAccount: "account-b",
      accountGeneration: 5,
      planLoadRevision: 0,
      intentRevision: 0,
      durableIntentRevision: 0,
      reconcileRunning: null,
      reconcileAbortController: null,
      reconcileRequested: false,
      planRefreshNeeded: false,
      reconciliationPersistenceFailure: false,
      syncTimer: undefined,
      lastMutationTime: 0,
      volatileWriteFailure: false,
      retryablePersistenceFailure: false,
      devicePersistenceRetry: null,
      rejectedWriteFailure: false,
      restoringAccount: null,
      plans: [],
    });
    expect(runtime.savedSnapshots.size).toBe(0);
    // The next account must never vouch for the previous account's years.
    expect(runtime.confirmedPlans.size).toBe(0);
    expect(runtime.savedSnapshotPlans.size).toBe(0);
    expect(runtime.volatileWriteFailureYears.size).toBe(0);
    await expect(runtime.localWriteChain).resolves.toBeUndefined();
  });

  it("invalidates retained work when the owning app unmounts", () => {
    const runtime = dirtyRuntime();
    const ownerController = runtime.ownerController;
    const reconciliation = runtime.reconcileAbortController;

    disposePlanSessionRuntime(runtime);

    expect(ownerController.signal.aborted).toBe(true);
    expect(reconciliation?.signal.aborted).toBe(true);
    expect(runtime.activeAccount).toBeNull();
    expect(runtime.accountGeneration).toBe(5);
    expect(runtime.reconcileRunning).toBeNull();
    expect(runtime.syncTimer).toBeUndefined();
  });

  it("rejects callbacks retained by an unmounted or replayed owner", () => {
    const runtime = dirtyRuntime();
    const disposedOwner = runtime.ownerController;
    disposedOwner.abort();

    expect(
      beginOwnedPlanSessionRuntime(runtime, "account-b", disposedOwner.signal),
    ).toBeNull();
    runtime.ownerController = new AbortController();
    const staleOwner = new AbortController();
    expect(
      beginOwnedPlanSessionRuntime(runtime, "account-b", staleOwner.signal),
    ).toBeNull();
    expect(runtime.activeAccount).toBe("account-a");
    expect(runtime.accountGeneration).toBe(4);
  });
});
