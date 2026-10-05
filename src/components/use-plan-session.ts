import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type SetStateAction,
} from "react";
import type { User } from "@/domain/api-contracts";
import {
  resetSerializedPlans,
  type AccountPersistenceRetry,
  type ConfirmedServerPlans,
} from "./sync-state";
import type { SaveState, StoredPlan, WorkspaceLocation } from "./plan-types";

export type PlanSessionPhase =
  "loading" | "signed-out" | "onboarding" | "ready";

interface SessionState {
  user: User | null;
  accountGeneration: number;
  plans: StoredPlan[];
  draft: StoredPlan | null;
  loading: boolean;
  location: WorkspaceLocation;
  saveState: SaveState;
  localSaveRetry: number;
  authNotice: string;
  startupValidationPending: boolean;
  // True only while the displayed plans came from the device cache *and* an
  // authoritative refresh is still in flight. Nothing about sync, the outbox or
  // what the device stores depends on it: it exists so the surfaces can reserve
  // the headline box instead of painting a number that is about to change
  // meaning (C9, never-cross rule 3). It is never set when the device cannot
  // reach the server, because then the cached plan *is* the settled value.
  planAwaitingAuthority: boolean;
}

type SessionAction =
  | { type: "user"; value: User | null }
  | { type: "plans"; value: StoredPlan[] }
  | { type: "draft"; value: SetStateAction<StoredPlan | null> }
  | { type: "loading"; value: boolean }
  | { type: "location"; value: WorkspaceLocation }
  | { type: "save"; value: SaveState }
  | { type: "retry"; value: SetStateAction<number> }
  | { type: "awaiting-authority" }
  | { type: "startup-validation"; value: boolean }
  | { type: "account-transition"; accountGeneration: number }
  | {
      type: "signed-out";
      notice: string;
      accountGeneration: number;
    };

export interface PlanSessionRuntime {
  savedSnapshots: Map<number, string>;
  confirmedPlans: ConfirmedServerPlans;
  plans: StoredPlan[];
  activeAccount: string | null;
  accountGeneration: number;
  ownerController: AbortController;
  planLoadRevision: number;
  intentRevision: number;
  durableIntentRevision: number;
  localWriteChain: Promise<void>;
  reconcileRunning: Promise<void> | null;
  reconcileAbortController: AbortController | null;
  reconcileRequested: boolean;
  planRefreshNeeded: boolean;
  reconciliationPersistenceFailure: boolean;
  syncTimer: number | undefined;
  lastMutationTime: number;
  volatileWriteFailureYears: Set<number>;
  volatileWriteFailure: boolean;
  retryablePersistenceFailure: boolean;
  devicePersistenceRetry: AccountPersistenceRetry | null;
  rejectedWriteFailure: boolean;
  restoringAccount: string | null;
  startupValidationPending: boolean;
  skipNextSessionValidation: boolean;
}

const initialState: SessionState = {
  user: null,
  accountGeneration: 0,
  plans: [],
  draft: null,
  loading: true,
  location: { route: { screen: "home" } },
  saveState: "saved",
  localSaveRetry: 0,
  authNotice: "",
  startupValidationPending: true,
  planAwaitingAuthority: false,
};

function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "user":
      return { ...state, user: action.value };
    case "plans":
      // A new plan set is the authoritative answer the reserved box was waiting
      // for (or the user's own edit, which they made deliberately). Either way
      // what is on screen is now settled.
      return { ...state, plans: action.value, planAwaitingAuthority: false };
    case "draft":
      return {
        ...state,
        draft:
          typeof action.value === "function"
            ? action.value(state.draft)
            : action.value,
      };
    case "loading":
      return { ...state, loading: action.value };
    case "location":
      return { ...state, location: action.value };
    case "save":
      // "saving" is the reconciler still working, so the refresh is still in
      // flight. Every other save state is a resolution — including a failed
      // one — and a refresh that will not arrive must never hold the box
      // reserved: the cached plan becomes the settled value at that point.
      return {
        ...state,
        saveState: action.value,
        planAwaitingAuthority:
          state.planAwaitingAuthority && action.value === "saving",
      };
    case "retry":
      return {
        ...state,
        localSaveRetry:
          typeof action.value === "function"
            ? action.value(state.localSaveRetry)
            : action.value,
      };
    case "awaiting-authority":
      return { ...state, planAwaitingAuthority: true };
    case "startup-validation":
      return { ...state, startupValidationPending: action.value };
    case "account-transition":
      return {
        ...state,
        user: null,
        accountGeneration: action.accountGeneration,
        plans: [],
        draft: null,
        location: { route: { screen: "home" } },
        saveState: "saved",
        localSaveRetry: 0,
        authNotice: "",
        startupValidationPending: false,
        planAwaitingAuthority: false,
      };
    case "signed-out":
      return {
        ...state,
        user: null,
        accountGeneration: action.accountGeneration,
        plans: [],
        draft: null,
        loading: false,
        location: { route: { screen: "home" } },
        saveState: "saved",
        localSaveRetry: 0,
        authNotice: action.notice,
        startupValidationPending: false,
        planAwaitingAuthority: false,
      };
  }
}

export function transitionPlanSessionRuntime(
  runtime: PlanSessionRuntime,
  activeAccount: string | null,
): number {
  runtime.ownerController.abort();
  if (runtime.syncTimer !== undefined && typeof window !== "undefined")
    window.clearTimeout(runtime.syncTimer);
  runtime.reconcileAbortController?.abort();
  runtime.savedSnapshots = new Map();
  runtime.confirmedPlans = new Map();
  resetSerializedPlans();
  runtime.plans = [];
  runtime.activeAccount = activeAccount;
  runtime.accountGeneration += 1;
  runtime.ownerController = new AbortController();
  runtime.planLoadRevision = 0;
  runtime.intentRevision = 0;
  runtime.durableIntentRevision = 0;
  runtime.localWriteChain = Promise.resolve();
  runtime.reconcileRunning = null;
  runtime.reconcileAbortController = null;
  runtime.reconcileRequested = false;
  runtime.planRefreshNeeded = false;
  runtime.reconciliationPersistenceFailure = false;
  runtime.syncTimer = undefined;
  runtime.lastMutationTime = 0;
  runtime.volatileWriteFailureYears = new Set();
  runtime.volatileWriteFailure = false;
  runtime.retryablePersistenceFailure = false;
  runtime.devicePersistenceRetry = null;
  runtime.rejectedWriteFailure = false;
  runtime.restoringAccount = null;
  runtime.startupValidationPending = false;
  runtime.skipNextSessionValidation = false;
  return runtime.accountGeneration;
}

export function disposePlanSessionRuntime(runtime: PlanSessionRuntime): void {
  transitionPlanSessionRuntime(runtime, null);
  runtime.ownerController.abort();
}

export function beginOwnedPlanSessionRuntime(
  runtime: PlanSessionRuntime,
  accountId: string,
  ownerSignal: AbortSignal,
): number | null {
  if (ownerSignal.aborted || ownerSignal !== runtime.ownerController.signal)
    return null;
  return transitionPlanSessionRuntime(runtime, accountId);
}

export function requireAuthoritativePlanRefresh(
  runtime: Pick<PlanSessionRuntime, "planRefreshNeeded">,
): void {
  runtime.planRefreshNeeded = true;
}

export function usePlanSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const runtimeRef = useRef<PlanSessionRuntime>({
    savedSnapshots: new Map(),
    confirmedPlans: new Map(),
    plans: [],
    activeAccount: null,
    accountGeneration: 0,
    ownerController: new AbortController(),
    planLoadRevision: 0,
    intentRevision: 0,
    durableIntentRevision: 0,
    localWriteChain: Promise.resolve(),
    reconcileRunning: null,
    reconcileAbortController: null,
    reconcileRequested: false,
    planRefreshNeeded: false,
    reconciliationPersistenceFailure: false,
    syncTimer: undefined,
    lastMutationTime: 0,
    volatileWriteFailureYears: new Set(),
    volatileWriteFailure: false,
    retryablePersistenceFailure: false,
    devicePersistenceRetry: null,
    rejectedWriteFailure: false,
    restoringAccount: null,
    startupValidationPending: true,
    skipNextSessionValidation: false,
  });
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime.ownerController.signal.aborted)
      runtime.ownerController = new AbortController();
    return () => disposePlanSessionRuntime(runtime);
  }, []);

  useEffect(() => {
    runtimeRef.current.plans = state.plans;
  }, [state.plans]);

  const setUser = useCallback(
    (value: User | null) => dispatch({ type: "user", value }),
    [],
  );
  const setPlans = useCallback(
    (value: StoredPlan[]) => dispatch({ type: "plans", value }),
    [],
  );
  const setDraft = useCallback(
    (value: SetStateAction<StoredPlan | null>) =>
      dispatch({ type: "draft", value }),
    [],
  );
  const setLoading = useCallback(
    (value: boolean) => dispatch({ type: "loading", value }),
    [],
  );
  const setLocation = useCallback(
    (value: WorkspaceLocation) => dispatch({ type: "location", value }),
    [],
  );
  const setSaveState = useCallback(
    (value: SaveState) => dispatch({ type: "save", value }),
    [],
  );
  const setLocalSaveRetry = useCallback(
    (value: SetStateAction<number>) => dispatch({ type: "retry", value }),
    [],
  );
  const markPlanAwaitingAuthority = useCallback(
    () => dispatch({ type: "awaiting-authority" }),
    [],
  );
  const setStartupValidationPending = useCallback(
    (value: boolean) => dispatch({ type: "startup-validation", value }),
    [],
  );
  const beginPlanIntent = useCallback(
    () => ++runtimeRef.current.intentRevision,
    [],
  );
  const getOwnerSignal = useCallback(
    () => runtimeRef.current.ownerController.signal,
    [],
  );
  const beginAccount = useCallback(
    (
      accountId: string,
      ownerSignal = runtimeRef.current.ownerController.signal,
    ) => {
      const generation = beginOwnedPlanSessionRuntime(
        runtimeRef.current,
        accountId,
        ownerSignal,
      );
      if (generation === null) return null;
      dispatch({ type: "account-transition", accountGeneration: generation });
      return generation;
    },
    [],
  );
  const invalidateSession = useCallback((notice: string) => {
    const accountGeneration = transitionPlanSessionRuntime(
      runtimeRef.current,
      null,
    );
    dispatch({ type: "signed-out", notice, accountGeneration });
  }, []);

  const phase: PlanSessionPhase = state.loading
    ? "loading"
    : !state.user
      ? "signed-out"
      : !state.draft
        ? "onboarding"
        : "ready";

  return {
    ...state,
    phase,
    runtimeRef,
    setUser,
    setPlans,
    setDraft,
    setLoading,
    setLocation,
    setSaveState,
    setLocalSaveRetry,
    markPlanAwaitingAuthority,
    setStartupValidationPending,
    beginPlanIntent,
    getOwnerSignal,
    beginAccount,
    invalidateSession,
  };
}

export type PlanSessionController = ReturnType<typeof usePlanSession>;
