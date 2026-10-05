import { describe, expect, it, vi } from "vitest";
import type { BudgetCategory, TransactionEntry } from "@/domain/budget";
import { storedPlan } from "@/test/fixtures/plans";
import { commitFastLogEntry } from "@/domain/fast-log";
import type { StoredPlan } from "@/domain/stored-plan";
import {
  resetSerializedPlans,
  serializedPlan,
  completeServerPlans,
  confirmPublishedPlans,
  knownPlanRevisions,
  type ConfirmedServerPlans,
  applyDraftChange,
  authenticationBroadcastTransition,
  cancelAccountPersistenceRetry,
  canPublishPlanSnapshot,
  canConfirmSaved,
  copyForwardIntentSnapshot,
  displayedSaveState,
  durableLogoutProblem,
  enqueueSerializedIntent,
  hasDurabilityGap,
  intentAwaitingDurableWrite,
  isCurrentAccountOperation,
  mergePlansWithLocalIntent,
  planIntentForYear,
  prepareCopyForward,
  publishDurabilityGap,
  reconciliationCompletionState,
  reconciliationStateWithPersistencePriority,
  registerPlanWriteFailure,
  removableAcknowledgementIds,
  queueAccountPersistenceRetry,
  replacePlanIntent,
  resolvePlanWriteSuccess,
  runDevicePersistenceRetry,
  shouldEvictAccount,
  shouldInvalidateForAuthentication,
  subscribeToDurabilityGap,
  unflushedIntentMutations,
  userWithLatestSession,
} from "./sync-state";

describe("what the status chip is allowed to claim", () => {
  it("refuses to say Saved over an edit still inside an input", () => {
    expect(displayedSaveState("saved", true)).toBe("unsaved");
    expect(displayedSaveState("saved", false)).toBe("saved");
  });

  it("never softens a state that already reports trouble", () => {
    expect(displayedSaveState("saving", true)).toBe("saving");
    expect(displayedSaveState("offline", true)).toBe("offline");
    expect(displayedSaveState("local-error", true)).toBe("local-error");
    expect(displayedSaveState("sync-error", true)).toBe("sync-error");
    expect(displayedSaveState("rejected", true)).toBe("rejected");
  });
});

/**
 * The second "Saved over unsaved work": fifteen category amounts were measured
 * sitting in memory under a `Saved` chip while the device write chain was
 * stalled behind a held account lock. `saveState` cannot see that — it becomes
 * `saving` from inside the local write's `then`, which is precisely what never
 * runs — so the gap has to be read off the two things that do know: what the
 * session is holding, and what the device last stored.
 */
describe("an edit the engine was handed and has not stored yet", () => {
  const stored = storedPlan(2026, { startingSavingsCents: 2_850_000 });
  const snapshots = new Map([[2026, JSON.stringify(stored)]]);
  const inMemory = { ...stored, startingSavingsCents: 3_100_000 };

  it("is not reported when the session matches the device", () => {
    expect(intentAwaitingDurableWrite([stored], snapshots)).toBe(false);
  });

  it("is reported while the write chain is stalled", () => {
    expect(intentAwaitingDurableWrite([inMemory], snapshots)).toBe(true);
  });

  it("is what stops the chip saying Saved over it", () => {
    expect(
      displayedSaveState(
        "saved",
        intentAwaitingDurableWrite([inMemory], snapshots),
      ),
    ).toBe("unsaved");
  });

  /** A plan with no baseline is one the device never stored, not a gap. */
  it("is not reported for a plan this device has no snapshot of", () => {
    expect(intentAwaitingDurableWrite([stored], new Map())).toBe(false);
  });

  it("notifies the chip only when the answer changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToDurabilityGap(() =>
      seen.push(hasDurabilityGap()),
    );
    try {
      publishDurabilityGap(true);
      publishDurabilityGap(true);
      publishDurabilityGap(false);

      expect(seen).toEqual([true, false]);
      expect(hasDurabilityGap()).toBe(false);
    } finally {
      unsubscribe();
      publishDurabilityGap(false);
    }
  });
});

describe("the intent a dying document still has to hand over", () => {
  const baseline = storedPlan(2026, { startingSavingsCents: 2_850_000 });
  const snapshots = new Map([[2026, JSON.stringify(baseline)]]);
  let nextId = 0;
  const createId = () =>
    `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

  it("sends nothing when the session matches what the device stored", () => {
    expect(
      unflushedIntentMutations(
        [baseline],
        snapshots,
        "2026-07-12T00:00:00.000Z",
        createId,
      ),
    ).toEqual([]);
  });

  it("sends only the difference the durable write never saw", () => {
    const edited = { ...baseline, startingSavingsCents: 9_900_000 };

    const mutations = unflushedIntentMutations(
      [edited],
      snapshots,
      "2026-07-12T00:00:00.000Z",
      createId,
    );

    expect(mutations).toHaveLength(1);
    expect(mutations[0].planYear).toBe(2026);
    expect(mutations[0].field).toBe("startingSavingsCents");
    expect(mutations[0].value).toBe(9_900_000);
    expect(mutations[0].updatedAt).toBe("2026-07-12T00:00:00.000Z");
  });

  it("sends a cleared optional scalar as null, never as nothing", () => {
    const edited = { ...baseline };
    delete edited.startingSavingsCents;

    const mutations = unflushedIntentMutations(
      [edited],
      snapshots,
      "2026-07-12T00:00:00.000Z",
      createId,
    );

    expect(mutations.map(({ field, value }) => [field, value])).toEqual([
      ["startingSavingsCents", null],
    ]);
    expect(JSON.parse(JSON.stringify(mutations[0])).value).toBeNull();
  });

  it("ignores a plan the device has never durably stored", () => {
    expect(
      unflushedIntentMutations(
        [storedPlan(2027)],
        snapshots,
        "2026-07-12T00:00:00.000Z",
        createId,
      ),
    ).toEqual([]);
  });
});

describe("sync durability state", () => {
  it("fences delayed work across same-account reauthentication", () => {
    const owner = new AbortController();
    const runtime = {
      activeAccount: "account-a" as string | null,
      accountGeneration: 4,
    };
    const isCurrent = () =>
      isCurrentAccountOperation("account-a", 4, owner.signal, runtime);

    expect(isCurrent()).toBe(true);
    owner.abort();
    runtime.activeAccount = null;
    runtime.accountGeneration = 5;
    runtime.activeAccount = "account-a";
    runtime.accountGeneration = 6;

    expect(isCurrent()).toBe(false);
  });

  it("applies an open Fast Log commit to the latest reconciled plan", () => {
    const opened = storedPlan(2026);
    const category: BudgetCategory = {
      id: "00000000-0000-4000-8000-000000000301",
      name: "Food",
      group: "Needs",
      cadence: "monthly",
      amountCents: 100_000,
      sortOrder: 0,
      guidanceBucket: "needs",
      colorToken: "blue",
      archived: false,
    };
    const remote: TransactionEntry = {
      id: "00000000-0000-4000-8000-000000000302",
      categoryId: category.id,
      amountCents: 1_000,
      title: "Remote entry",
      date: "2026-07-24",
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T12:00:00.000Z",
    };
    const local = {
      ...remote,
      id: "00000000-0000-4000-8000-000000000303",
      title: "Local entry",
      updatedAt: "2026-07-24T12:01:00.000Z",
    };
    const latest: StoredPlan = {
      ...opened,
      expenses: [category],
      transactions: [remote],
    };

    const committed = applyDraftChange(latest, (current) =>
      commitFastLogEntry(current, local),
    );

    expect(committed.transactions).toEqual([remote, local]);
  });

  it("does not publish a response after a newer intent is accepted or while it is not durable", async () => {
    let currentIntentRevision = 3;
    let durableIntentRevision = 3;
    const capturedIntentRevision = currentIntentRevision;
    let releaseResponse: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    currentIntentRevision += 1;
    releaseResponse?.();
    await response;

    expect(
      canPublishPlanSnapshot(
        capturedIntentRevision,
        currentIntentRevision,
        durableIntentRevision,
      ),
    ).toBe(false);
    durableIntentRevision = currentIntentRevision;
    expect(
      canPublishPlanSnapshot(
        capturedIntentRevision,
        currentIntentRevision,
        durableIntentRevision,
      ),
    ).toBe(false);
    expect(
      canPublishPlanSnapshot(
        currentIntentRevision,
        currentIntentRevision,
        durableIntentRevision,
      ),
    ).toBe(true);
  });

  it("retains rejected mutation groups until corrected", () => {
    expect(
      removableAcknowledgementIds([
        { mutationId: "applied" },
        { mutationId: "rejected", rejected: true },
        { mutationId: "conflict", rejected: false },
      ]),
    ).toEqual(["applied", "conflict"]);
  });

  it("keeps a failed local write failed through an empty online reconciliation until persistence succeeds", () => {
    expect(
      reconciliationCompletionState({
        queuedMutationCount: 0,
        volatileWriteFailure: true,
        rejectedWriteFailure: false,
      }),
    ).toBe("local-error");

    expect(
      reconciliationCompletionState({
        queuedMutationCount: 0,
        volatileWriteFailure: false,
        rejectedWriteFailure: false,
      }),
    ).toBe("saved");
  });

  it("does not certify a failed plan year when a different year persists", () => {
    const failedPlanYears = new Set<number>();
    registerPlanWriteFailure(failedPlanYears, 2026);

    const after2027 = resolvePlanWriteSuccess(failedPlanYears, 2027, 0, 2);
    expect(after2027).toEqual({
      volatileWriteFailure: true,
      durableIntentRevision: 0,
    });
    expect(failedPlanYears).toEqual(new Set([2026]));

    const after2026Retry = resolvePlanWriteSuccess(
      failedPlanYears,
      2026,
      after2027.durableIntentRevision,
      2,
    );
    expect(after2026Retry).toEqual({
      volatileWriteFailure: false,
      durableIntentRevision: 2,
    });
    expect(failedPlanYears.size).toBe(0);
  });

  it("reports a durable no-op so a reverted failed year can recover", async () => {
    const persist = vi.fn(async () => undefined);
    const result = await enqueueSerializedIntent(
      Promise.resolve(),
      "original",
      () => "original",
      persist,
    );

    expect(result).toBe("unchanged");
    expect(persist).not.toHaveBeenCalled();
    const failedPlanYears = new Set([2026]);
    expect(resolvePlanWriteSuccess(failedPlanYears, 2026, 0, 1)).toEqual({
      volatileWriteFailure: false,
      durableIntentRevision: 1,
    });
  });

  it("retries failed startup persistence even when the draft needs no write", async () => {
    const events: string[] = [];

    await runDevicePersistenceRetry(
      async () => {
        events.push("startup-persistence");
      },
      () => {
        events.push("draft-persistence");
      },
    );

    expect(events).toEqual(["startup-persistence", "draft-persistence"]);
  });

  it("retries a standalone failed draft write without a startup retry", async () => {
    let draftRetries = 0;

    await runDevicePersistenceRetry(null, () => {
      draftRetries += 1;
    });

    expect(draftRetries).toBe(1);
  });

  it("keeps local persistence failures above reconciliation outcomes", () => {
    for (const candidate of [
      "saving",
      "offline",
      "rejected",
      "sync-error",
    ] as const) {
      expect(
        reconciliationStateWithPersistencePriority({
          candidate,
          volatileWriteFailure: true,
          retryablePersistenceFailure: false,
        }),
      ).toBe("local-error");
      expect(
        reconciliationStateWithPersistencePriority({
          candidate,
          volatileWriteFailure: false,
          retryablePersistenceFailure: true,
        }),
      ).toBe("local-error");
      expect(
        reconciliationStateWithPersistencePriority({
          candidate,
          volatileWriteFailure: false,
          retryablePersistenceFailure: false,
          reconciliationPersistenceFailure: true,
        }),
      ).toBe("local-error");
      expect(
        reconciliationStateWithPersistencePriority({
          candidate,
          volatileWriteFailure: false,
          retryablePersistenceFailure: false,
          rejectedWriteFailure: true,
        }),
      ).toBe("rejected");
    }
    expect(
      reconciliationStateWithPersistencePriority({
        candidate: "offline",
        volatileWriteFailure: true,
        retryablePersistenceFailure: false,
        rejectedWriteFailure: true,
      }),
    ).toBe("local-error");
    expect(
      reconciliationStateWithPersistencePriority({
        candidate: "sync-error",
        volatileWriteFailure: false,
        retryablePersistenceFailure: false,
        rejectedWriteFailure: true,
        syncRequestFailure: true,
      }),
    ).toBe("sync-error");
    expect(
      reconciliationStateWithPersistencePriority({
        candidate: "rejected",
        volatileWriteFailure: false,
        retryablePersistenceFailure: false,
      }),
    ).toBe("rejected");
  });

  it("does not treat incomplete local reconciliation as a failed sync request", () => {
    const candidate = reconciliationCompletionState({
      queuedMutationCount: 1,
      volatileWriteFailure: false,
      rejectedWriteFailure: true,
    });

    expect(candidate).toBe("sync-error");
    expect(
      reconciliationStateWithPersistencePriority({
        candidate,
        volatileWriteFailure: false,
        retryablePersistenceFailure: false,
        rejectedWriteFailure: true,
      }),
    ).toBe("rejected");
  });

  it("keeps the draft retry pending when startup persistence still fails", async () => {
    let retriedDraft = false;

    await expect(
      runDevicePersistenceRetry(
        async () => {
          throw new Error("IndexedDB remains unavailable");
        },
        () => {
          retriedDraft = true;
        },
      ),
    ).rejects.toThrow("IndexedDB remains unavailable");

    expect(retriedDraft).toBe(false);
  });

  it("replaces and cancels persistence retries across account changes", async () => {
    const events: string[] = [];
    const accountA = queueAccountPersistenceRetry(
      null,
      "user-a",
      1,
      async () => {
        events.push("user-a");
      },
      "user-a",
      1,
    );
    const accountB = queueAccountPersistenceRetry(
      accountA,
      "user-b",
      2,
      async () => {
        events.push("user-b");
      },
      "user-b",
      2,
    );

    expect(cancelAccountPersistenceRetry(accountB, "user-a")).toBe(accountB);
    expect(cancelAccountPersistenceRetry(accountB, "user-b")).toBeNull();
    await accountB!.retry();
    expect(events).toEqual(["user-b"]);
  });

  it("does not let a late retry admission from an evicted account replace the active account", () => {
    const accountB = queueAccountPersistenceRetry(
      null,
      "user-b",
      2,
      async () => {},
      "user-b",
      2,
    );
    const lateAccountA = queueAccountPersistenceRetry(
      accountB,
      "user-a",
      1,
      async () => {},
      "user-b",
      2,
    );

    expect(lateAccountA).toBe(accountB);
  });

  it("does not confirm Saved after a rejection or volatile write failure", () => {
    expect(
      canConfirmSaved({
        queuedMutationCount: 0,
        volatileWriteFailure: false,
        rejectedWriteFailure: true,
      }),
    ).toBe(false);
    expect(
      canConfirmSaved({
        queuedMutationCount: 0,
        volatileWriteFailure: true,
        rejectedWriteFailure: false,
      }),
    ).toBe(false);
  });

  it("refuses logout when the displayed draft is not durable", () => {
    expect(
      durableLogoutProblem({
        draftSnapshot: "changed",
        durableSnapshot: "old",
        volatileWriteFailure: false,
        rejectedWriteFailure: false,
      }),
    ).toMatch(/not finished saving/i);
    expect(
      durableLogoutProblem({
        draftSnapshot: "same",
        durableSnapshot: "same",
        volatileWriteFailure: true,
        rejectedWriteFailure: false,
      }),
    ).toMatch(/not finished saving/i);
  });

  it("persists a rapid edit followed by a revert against the latest durable baseline", async () => {
    let durable = "original";
    let releaseFirst: (() => void) | undefined;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transitions: Array<[string, string]> = [];
    let chain: Promise<unknown> = Promise.resolve();

    const enqueue = (intent: string, pause = false) => {
      chain = enqueueSerializedIntent(
        chain,
        intent,
        () => durable,
        async (baseline) => {
          if (pause) await firstWritePaused;
          transitions.push([baseline, intent]);
          durable = intent;
        },
      );
    };

    enqueue("edited", true);
    enqueue("original");
    releaseFirst?.();
    await chain;

    expect(transitions).toEqual([
      ["original", "edited"],
      ["edited", "original"],
    ]);
    expect(durable).toBe("original");
  });

  it("does not manufacture a stale revert when changing years during persistence", async () => {
    type PlanIntent = { year: number; value: string };
    let intents: PlanIntent[] = [
      { year: 2026, value: "old" },
      { year: 2027, value: "other year" },
    ];
    const durable = new Map(intents.map((plan) => [plan.year, plan.value]));
    let releaseFirstWrite: (() => void) | undefined;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const transitions: Array<[string, string]> = [];
    let chain: Promise<unknown> = Promise.resolve();

    const edited = { year: 2026, value: "edited" };
    intents = replacePlanIntent(intents, edited);
    chain = enqueueSerializedIntent(
      chain,
      edited.value,
      () => durable.get(edited.year),
      async (baseline) => {
        await firstWritePaused;
        transitions.push([baseline, edited.value]);
        durable.set(edited.year, edited.value);
      },
    );

    expect(planIntentForYear(intents, 2027)?.value).toBe("other year");
    const selectedAfterReturning = planIntentForYear(intents, 2026);
    expect(selectedAfterReturning).toEqual(edited);
    chain = enqueueSerializedIntent(
      chain,
      selectedAfterReturning!.value,
      () => durable.get(2026),
      async (baseline) => {
        transitions.push([baseline, selectedAfterReturning!.value]);
        durable.set(2026, selectedAfterReturning!.value);
      },
    );

    releaseFirstWrite?.();
    await chain;

    expect(transitions).toEqual([["old", "edited"]]);
    expect(durable.get(2026)).toBe("edited");
  });

  it("evicts an account whose offline cache restoration is still in flight", () => {
    expect(shouldEvictAccount(null, "user-a", "user-a")).toBe(true);
    expect(shouldEvictAccount("user-b", null, "user-a")).toBe(false);
  });

  it("preserves queued edits when the same account authenticates in another tab", () => {
    expect(shouldInvalidateForAuthentication("user-a", "user-a")).toBe(false);
    expect(shouldInvalidateForAuthentication("user-a", "user-b")).toBe(true);
    expect(shouldInvalidateForAuthentication(null, "user-a")).toBe(true);
  });

  it("adopts only a valid same-account session identity and replaces close ownership", () => {
    const replaceCloseOwner = vi.fn();
    const user = {
      id: "user-a",
      email: "a@example.com",
      sessionId: "00000000-0000-4000-8000-000000000001",
    };

    expect(
      authenticationBroadcastTransition(
        "user-a",
        user,
        {
          userId: "user-a",
          sessionId: "00000000-0000-4000-8000-000000000002",
        },
        replaceCloseOwner,
      ),
    ).toEqual({
      invalidate: false,
      sessionIdentity: {
        userId: "user-a",
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
      user: {
        ...user,
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
    });
    expect(replaceCloseOwner).toHaveBeenCalledOnce();

    expect(
      authenticationBroadcastTransition(
        "user-a",
        user,
        { userId: "user-a", sessionId: "not-a-session-id" },
        vi.fn(),
      ).user,
    ).toBe(user);
  });

  it("retains a newer same-account session until startup can publish its user", () => {
    const transition = authenticationBroadcastTransition(
      "user-a",
      null,
      {
        userId: "user-a",
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
      vi.fn(),
    );

    expect(transition).toEqual({
      invalidate: false,
      sessionIdentity: {
        userId: "user-a",
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
      user: null,
    });
    expect(
      userWithLatestSession(
        {
          id: "user-a",
          email: "a@example.com",
          sessionId: "00000000-0000-4000-8000-000000000001",
        },
        transition.sessionIdentity ?? null,
      ),
    ).toMatchObject({
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("replays pending fields over fresh server state and keeps copied years", () => {
    const server = [
      storedPlan(2026, { stateCode: "TX", grossSalaryCents: 10_000_000 }),
      storedPlan(2027, { stateCode: "WA" }),
    ];
    const local = [
      storedPlan(2026, { stateCode: "CA", grossSalaryCents: 30_000_000 }),
    ];
    const pending = [
      {
        mutationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        planYear: 2026,
        field: "grossSalaryCents" as const,
        value: 20_000_000,
        updatedAt: "2026-07-12T01:00:00.000Z",
      },
      {
        mutationId: "00000000-0000-4000-8000-000000000081",
        planYear: 2026,
        field: "grossSalaryCents" as const,
        value: 30_000_000,
        updatedAt: "2026-07-12T01:00:01.000Z",
      },
    ];

    const merged = mergePlansWithLocalIntent(server, local, pending);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      year: 2026,
      stateCode: "TX",
      grossSalaryCents: 30_000_000,
    });
    expect(merged[1]).toMatchObject({ year: 2027, stateCode: "WA" });
  });

  it("compares copy-forward intent independently from refreshed sync metadata", () => {
    const displayed = {
      year: 2026,
      value: "edited source",
      updatedAt: "2026-07-12T01:00:00.000Z",
      fieldVersions: {},
    };
    const reconciled = {
      ...displayed,
      updatedAt: "2026-07-12T01:00:01.000Z",
      fieldVersions: {
        value: { updatedAt: "2026-07-12T01:00:01.000Z", mutationId: "m1" },
      },
    };

    expect(copyForwardIntentSnapshot(displayed)).toBe(
      copyForwardIntentSnapshot(reconciled),
    );
    expect(
      copyForwardIntentSnapshot({ ...reconciled, value: "remote source" }),
    ).not.toBe(copyForwardIntentSnapshot(displayed));
  });

  it("delivers the displayed source intent before allowing copy-forward", async () => {
    let releaseLocalWrite: (() => void) | undefined;
    const localWrites = new Promise<void>((resolve) => {
      releaseLocalWrite = resolve;
    });
    const events: string[] = [];

    const preflight = prepareCopyForward({
      localWrites,
      durabilityProblem: () => null,
      reconcile: async () => {
        events.push("reconciled");
      },
      queuedMutationCount: async () => 0,
    }).then(() => events.push("copy-ready"));

    await Promise.resolve();
    expect(events).toEqual([]);
    releaseLocalWrite?.();
    await preflight;
    expect(events).toEqual(["reconciled", "copy-ready"]);
  });

  it("refuses copy-forward when reconciliation rejects the source intent", async () => {
    let rejected = false;
    await expect(
      prepareCopyForward({
        localWrites: Promise.resolve(),
        durabilityProblem: () =>
          rejected ? "The source change was rejected." : null,
        reconcile: async () => {
          rejected = true;
        },
        queuedMutationCount: async () => 0,
      }),
    ).rejects.toThrow("source change was rejected");
  });
});

describe("confirmed server copies", () => {
  it("confirms only years published as the server's own copy, and forgets the rest", () => {
    const server2025 = storedPlan(2025);
    const server2026 = storedPlan(2026);
    const newerCached2026 = {
      ...server2026,
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const confirmed: ConfirmedServerPlans = new Map([
      [2026, { revision: "old", plan: server2026 }],
    ]);

    confirmPublishedPlans(
      confirmed,
      [server2025, newerCached2026],
      [server2025, server2026],
      [
        { year: 2025, revision: "a" },
        { year: 2026, revision: "b" },
      ],
    );

    expect([...confirmed.keys()]).toEqual([2025]);
    expect(knownPlanRevisions(confirmed)).toEqual([
      { year: 2025, revision: "a" },
    ]);
  });

  it("treats a response without omitted years as the complete account", () => {
    const plans = [storedPlan(2026)];
    expect(completeServerPlans(plans, undefined, new Map())).toEqual(plans);
    expect(completeServerPlans(plans, [2025], new Map())).toBeNull();
  });
});

describe("cached plan serialization", () => {
  const withTransaction = (plan: StoredPlan, title: string): StoredPlan => ({
    ...plan,
    transactions: [
      ...plan.transactions,
      {
        id: "00000000-0000-4000-8000-000000000901",
        categoryId: "00000000-0000-4000-8000-000000000902",
        amountCents: 1_234,
        title,
        date: "2026-03-01",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ],
  });

  it("serializes exactly like JSON.stringify, before and after a reset", () => {
    const plans = [storedPlan(2025), withTransaction(storedPlan(2026), "Tea")];
    for (const plan of plans) {
      expect(serializedPlan(plan)).toBe(JSON.stringify(plan));
      expect(serializedPlan(plan)).toBe(JSON.stringify(plan));
    }
    resetSerializedPlans();
    for (const plan of plans)
      expect(serializedPlan(plan)).toBe(JSON.stringify(plan));
  });

  it("still sees every edit as a new plan object, whatever was cached before", () => {
    const durable = storedPlan(2026);
    const snapshots = new Map([[2026, serializedPlan(durable)]]);
    expect(intentAwaitingDurableWrite([durable], snapshots)).toBe(false);

    const edited = withTransaction(durable, "Coffee");
    expect(intentAwaitingDurableWrite([edited], snapshots)).toBe(true);

    // The edit becomes durable; a later edit of the same year is again a gap.
    snapshots.set(2026, serializedPlan(edited));
    expect(intentAwaitingDurableWrite([edited], snapshots)).toBe(false);
    const reverted = { ...edited, transactions: durable.transactions };
    expect(intentAwaitingDurableWrite([reverted], snapshots)).toBe(true);

    // An equal copy is not a gap; a stale snapshot is.
    expect(intentAwaitingDurableWrite([{ ...edited }], snapshots)).toBe(false);
    snapshots.set(2026, serializedPlan(durable));
    expect(intentAwaitingDurableWrite([edited], snapshots)).toBe(true);
  });
});
