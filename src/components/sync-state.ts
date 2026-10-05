import {
  authenticatedUserSchema,
  sessionIdSchema,
  type User,
} from "@/domain/api-contracts";
import { storedPlanSchema } from "@/domain/plan-schema";
import type { PlanRevision } from "@/domain/api-contracts";
import type { StoredPlan } from "@/domain/stored-plan";
import { diffPlanMutations, type SyncMutation } from "@/domain/sync";
import type { SaveState } from "./plan-types";
import {
  applyDecodedSyncMutations,
  decodeSyncMutation,
  type DecodedSyncMutation,
} from "@/domain/sync-decoder";

interface SavedStateInput {
  queuedMutationCount: number;
  volatileWriteFailure: boolean;
  rejectedWriteFailure: boolean;
}

export function removableAcknowledgementIds(
  acknowledgements: readonly {
    mutationId: string;
    rejected?: boolean;
  }[],
): string[] {
  return acknowledgements
    .filter(({ rejected }) => !rejected)
    .map(({ mutationId }) => mutationId);
}

export function canConfirmSaved(input: SavedStateInput): boolean {
  return (
    input.queuedMutationCount === 0 &&
    !input.volatileWriteFailure &&
    !input.rejectedWriteFailure
  );
}

export function reconciliationCompletionState(
  input: SavedStateInput,
): "saved" | "local-error" | "sync-error" {
  if (canConfirmSaved(input)) return "saved";
  return input.volatileWriteFailure ? "local-error" : "sync-error";
}

export function reconciliationStateWithPersistencePriority(input: {
  candidate: SaveState;
  volatileWriteFailure: boolean;
  retryablePersistenceFailure: boolean;
  reconciliationPersistenceFailure?: boolean;
  rejectedWriteFailure?: boolean;
  syncRequestFailure?: boolean;
}): SaveState {
  if (
    input.volatileWriteFailure ||
    input.retryablePersistenceFailure ||
    input.reconciliationPersistenceFailure
  )
    return "local-error";
  if (input.syncRequestFailure) return "sync-error";
  return input.rejectedWriteFailure ? "rejected" : input.candidate;
}

/** What the status chip is allowed to claim, which is one thing more than the
 * sync engine has an opinion about. `saveState` describes writes the engine has
 * been given; an edit that has not reached durable storage is by construction
 * one it cannot vouch for, so "Saved" over it is an assertion about work that
 * exists nowhere but this process's memory. Only that claim is overridden:
 * `saving`, `offline` and the three failures already tell the reader nothing is
 * settled, and replacing them would hide a problem behind a milder word. */
export type DisplayedSaveState = SaveState | "unsaved";

export function displayedSaveState(
  saveState: SaveState,
  editAwaitingDurableWrite: boolean,
): DisplayedSaveState {
  return editAwaitingDurableWrite && saveState === "saved"
    ? "unsaved"
    : saveState;
}

let serializedPlans = new WeakMap<StoredPlan, string>();

/**
 * A plan's JSON, computed once per plan object. A published plan is never
 * mutated — edits and server answers always produce new objects, the same
 * invariant `calculatePlan(draft)`'s memo relies on — so an object's
 * serialization cannot change while it is cached. Reset with the account.
 */
export function serializedPlan(plan: StoredPlan): string {
  let serialized = serializedPlans.get(plan);
  if (serialized === undefined) {
    serialized = JSON.stringify(plan);
    serializedPlans.set(plan, serialized);
  }
  return serialized;
}

export function resetSerializedPlans(): void {
  serializedPlans = new WeakMap();
}

/**
 * The durable baseline a local edit is diffed against. The plan object the
 * snapshot was serialized from is reused only when it still serializes to
 * exactly that snapshot; anything else re-reads the snapshot through the
 * schema, as before.
 */
export function durableBaseline(
  snapshot: string,
  held: StoredPlan | undefined,
): StoredPlan {
  return held !== undefined && serializedPlan(held) === snapshot
    ? held
    : storedPlanSchema.parse(JSON.parse(snapshot));
}

/** Plans the session is holding that differ from what this device last stored. */
function plansDivergingFromDurableState(
  plans: readonly StoredPlan[],
  savedSnapshots: ReadonlyMap<number, string>,
): { plan: StoredPlan; baseline: string }[] {
  return plans.flatMap((plan) => {
    const baseline = savedSnapshots.get(plan.year);
    if (baseline === undefined || baseline === serializedPlan(plan)) return [];
    return [{ plan, baseline }];
  });
}

/**
 * Whether an edit is currently living only in this process's memory.
 *
 * `saveState` cannot answer this. It moves to `saving` from inside the local
 * write's `then`, so between the moment a commit hands an edit over and the
 * moment IndexedDB acknowledges it the chip still reads whatever it read
 * before — `Saved`, normally. That window is microseconds when the write chain
 * is healthy and the whole session when it is not: a second tab holding the
 * account Web Lock, an interrupted account operation, evicted storage. Fifteen
 * category amounts were measured sitting in memory under a `Saved` chip that
 * way, which is the same lie the buffered-edit override exists to refuse, one
 * layer further down.
 */
export function intentAwaitingDurableWrite(
  plans: readonly StoredPlan[],
  savedSnapshots: ReadonlyMap<number, string>,
): boolean {
  return plansDivergingFromDurableState(plans, savedSnapshots).length > 0;
}

/**
 * The intent that exists only in memory, as mutations: for every plan, the
 * difference between what the session is holding and the last snapshot this
 * device durably stored.
 *
 * Anything already in that snapshot is in the outbox, which survives the
 * document and drains on the next launch, so it is not at risk and is not
 * re-sent. What is left is exactly the edit a commit has just handed over and
 * whose ordinary write path — an IndexedDB transaction behind two Web Locks,
 * then a 650 ms debounce — has no chance of finishing before the document dies.
 */
export function unflushedIntentMutations(
  plans: readonly StoredPlan[],
  savedSnapshots: ReadonlyMap<number, string>,
  updatedAt: string,
  createId?: () => string,
): SyncMutation[] {
  return plansDivergingFromDurableState(plans, savedSnapshots).flatMap(
    ({ plan, baseline }) =>
      diffPlanMutations(
        storedPlanSchema.parse(JSON.parse(baseline)),
        plan,
        updatedAt,
        createId,
      ),
  );
}

const durabilityListeners = new Set<() => void>();
/**
 * The two independent ways an edit can be sitting nowhere durable. They are
 * tracked apart because different code discovers them at different moments and
 * they are resolved by different events, and reported together because the chip
 * has exactly one thing to say about both.
 */
const durabilityGaps = { intentAwaitingWrite: false, unloadIntentLost: false };

function publishDurability(
  gap: keyof typeof durabilityGaps,
  present: boolean,
): void {
  if (present === durabilityGaps[gap]) return;
  durabilityGaps[gap] = present;
  for (const listener of [...durabilityListeners]) listener();
}

/**
 * Published by the sync engine after every render, because the two sides of the
 * comparison — the session's plans and the device's last stored snapshots —
 * live on a ref and change without one. Every write to either is paired with a
 * dispatch, so "after every render" is exactly "whenever this could differ".
 */
export function publishDurabilityGap(present: boolean): void {
  publishDurability("intentAwaitingWrite", present);
}

/**
 * Published when an edit handed to the unload flush reached no durable carrier
 * at all: `localStorage` partitioned away, disabled or full, or a journal a
 * later launch could not parse.
 *
 * Nothing above can compute this. The comparison `publishDurabilityGap` makes
 * is between memory and IndexedDB, and both can be perfectly healthy while the
 * one synchronous write a dying document had time for was refused. It is the
 * boolean `recordUnloadJournal` returns — computed, correct, and discarded at
 * the call site until now, which is why the chip went on reading `Saved` over
 * an edit that reached no buffer, no journal, no outbox and no server. That is
 * Blocker 1's symptom verbatim, for every reader in a blocked-storage context.
 *
 * It is cleared by the two things that can honestly clear it: a later write
 * that does reach the device, and a launch that finds nothing lost.
 */
export function publishUndurableUnloadIntent(present: boolean): void {
  publishDurability("unloadIntentLost", present);
}

export function hasDurabilityGap(): boolean {
  return durabilityGaps.intentAwaitingWrite || durabilityGaps.unloadIntentLost;
}

export function subscribeToDurabilityGap(listener: () => void): () => void {
  durabilityListeners.add(listener);
  return () => {
    durabilityListeners.delete(listener);
  };
}

/** Nothing is ever awaiting a device write on a server that has no device. */
export function noDurabilityGapOnServer(): false {
  return false;
}

export function canPublishPlanSnapshot(
  capturedIntentRevision: number,
  currentIntentRevision: number,
  durableIntentRevision: number,
): boolean {
  return (
    capturedIntentRevision === currentIntentRevision &&
    durableIntentRevision === currentIntentRevision
  );
}

export function registerPlanWriteFailure(
  failedPlanYears: Set<number>,
  planYear: number,
): void {
  failedPlanYears.add(planYear);
}

export function resolvePlanWriteSuccess(
  failedPlanYears: Set<number>,
  planYear: number,
  durableIntentRevision: number,
  persistedIntentRevision: number,
): {
  volatileWriteFailure: boolean;
  durableIntentRevision: number;
} {
  failedPlanYears.delete(planYear);
  const volatileWriteFailure = failedPlanYears.size > 0;
  return {
    volatileWriteFailure,
    durableIntentRevision: volatileWriteFailure
      ? durableIntentRevision
      : Math.max(durableIntentRevision, persistedIntentRevision),
  };
}

export async function runDevicePersistenceRetry(
  retryStartupPersistence: (() => Promise<void>) | null,
  retryDraftPersistence: () => void | Promise<void>,
): Promise<void> {
  if (retryStartupPersistence) await retryStartupPersistence();
  await retryDraftPersistence();
}

export interface AccountPersistenceRetry {
  accountId: string;
  generation: number;
  retry: () => Promise<void>;
}

export function queueAccountPersistenceRetry(
  current: AccountPersistenceRetry | null,
  accountId: string,
  generation: number,
  retry: () => Promise<void>,
  activeAccountId: string | null,
  activeGeneration: number,
): AccountPersistenceRetry | null {
  if (activeAccountId !== accountId || activeGeneration !== generation)
    return current;
  if (current?.accountId !== accountId || current.generation !== generation)
    return { accountId, generation, retry };
  return {
    accountId,
    generation,
    retry: async () => {
      await current.retry();
      await retry();
    },
  };
}

export function isCurrentAccountLifecycle(
  retry: AccountPersistenceRetry,
  activeAccountId: string | null,
  activeGeneration: number,
): boolean {
  return (
    retry.accountId === activeAccountId && retry.generation === activeGeneration
  );
}

export function isCurrentAccountOperation(
  accountId: string,
  accountGeneration: number,
  ownerSignal: AbortSignal,
  current: {
    activeAccount: string | null;
    accountGeneration: number;
  },
): boolean {
  return (
    !ownerSignal.aborted &&
    current.activeAccount === accountId &&
    current.accountGeneration === accountGeneration
  );
}

export function cancelAccountPersistenceRetry(
  current: AccountPersistenceRetry | null,
  accountId?: string,
): AccountPersistenceRetry | null {
  if (!current || (accountId && current.accountId !== accountId))
    return current;
  return null;
}

interface LogoutDurabilityInput {
  draftSnapshot: string;
  durableSnapshot: string | undefined;
  volatileWriteFailure: boolean;
  rejectedWriteFailure: boolean;
}

export function durableLogoutProblem(
  input: LogoutDurabilityInput,
): string | null {
  if (
    input.volatileWriteFailure ||
    input.rejectedWriteFailure ||
    input.durableSnapshot === undefined ||
    input.draftSnapshot !== input.durableSnapshot
  ) {
    return "This plan has not finished saving. Keep this page open and retry before logging out.";
  }
  return null;
}

export function enqueueSerializedIntent(
  chain: Promise<unknown>,
  intentSnapshot: string,
  durableSnapshot: () => string | undefined,
  persist: (baselineSnapshot: string) => Promise<void>,
): Promise<"missing-baseline" | "unchanged" | "persisted"> {
  return chain.then(async () => {
    const baseline = durableSnapshot();
    if (!baseline) return "missing-baseline";
    if (baseline === intentSnapshot) return "unchanged";
    await persist(baseline);
    return "persisted";
  });
}

export function replacePlanIntent<T extends { year: number }>(
  plans: readonly T[],
  draft: T,
): T[] {
  return plans.map((plan) => (plan.year === draft.year ? draft : plan));
}

export type PlanDraftChange =
  StoredPlan | ((current: StoredPlan) => StoredPlan);

export function applyDraftChange(
  current: StoredPlan,
  change: PlanDraftChange,
): StoredPlan {
  return typeof change === "function" ? change(current) : change;
}

export function planIntentForYear<T extends { year: number }>(
  plans: readonly T[],
  year: number,
): T | undefined {
  return plans.find((plan) => plan.year === year);
}

export function shouldEvictAccount(
  activeAccountId: string | null,
  restoringAccountId: string | null,
  loggedOutAccountId: string,
): boolean {
  return (
    activeAccountId === loggedOutAccountId ||
    restoringAccountId === loggedOutAccountId
  );
}

export function shouldInvalidateForAuthentication(
  activeAccountId: string | null,
  authenticatedAccountId: string,
): boolean {
  return activeAccountId !== authenticatedAccountId;
}

export function authenticationBroadcastTransition(
  activeAccountId: string | null,
  currentUser: User | null,
  message: { userId?: unknown; sessionId?: unknown },
  replaceCloseOwner: () => void,
): {
  invalidate: boolean;
  sessionIdentity?: { userId: string; sessionId: string };
  user: User | null;
} {
  replaceCloseOwner();
  if (
    typeof message.userId !== "string" ||
    shouldInvalidateForAuthentication(activeAccountId, message.userId)
  ) {
    return { invalidate: true, user: currentUser };
  }
  const sessionId = sessionIdSchema.safeParse(message.sessionId);
  if (!sessionId.success) return { invalidate: false, user: currentUser };
  const sessionIdentity = { userId: message.userId, sessionId: sessionId.data };
  if (!currentUser) return { invalidate: false, sessionIdentity, user: null };
  const authenticated = authenticatedUserSchema.safeParse({
    ...currentUser,
    sessionId: sessionId.data,
  });
  return {
    invalidate: false,
    sessionIdentity,
    user: authenticated.success ? authenticated.data : currentUser,
  };
}

export function userWithLatestSession(
  user: User,
  sessionIdentity: { userId: string; sessionId: string } | null,
): User {
  if (!sessionIdentity || sessionIdentity.userId !== user.id) return user;
  return { ...user, sessionId: sessionIdentity.sessionId };
}

export function mergePlansWithLocalIntent(
  serverPlans: readonly StoredPlan[],
  localPlans: readonly StoredPlan[],
  pendingMutations: readonly SyncMutation[],
): StoredPlan[] {
  const merged = new Map(serverPlans.map((plan) => [plan.year, plan]));
  const serverYears = new Set(merged.keys());
  for (const plan of localPlans) {
    if (!serverYears.has(plan.year)) merged.set(plan.year, plan);
  }
  const pendingByYear = new Map<number, DecodedSyncMutation[]>();
  for (const mutation of pendingMutations) {
    if (!serverYears.has(mutation.planYear)) continue;
    const group = pendingByYear.get(mutation.planYear) ?? [];
    group.push(decodeSyncMutation(mutation));
    pendingByYear.set(mutation.planYear, group);
  }
  for (const [year, mutations] of pendingByYear) {
    merged.set(year, applyDecodedSyncMutations(merged.get(year)!, mutations));
  }
  return [...merged.values()].toSorted((left, right) => left.year - right.year);
}

export function copyForwardIntentSnapshot(plan: object): string {
  const intent = { ...plan } as Record<string, unknown>;
  delete intent.updatedAt;
  delete intent.fieldVersions;
  return JSON.stringify(intent);
}

interface CopyForwardPreparation {
  localWrites: Promise<void>;
  durabilityProblem: () => string | null;
  reconcile: () => Promise<void>;
  queuedMutationCount: () => Promise<number>;
}

export async function prepareCopyForward(
  preparation: CopyForwardPreparation,
): Promise<void> {
  await preparation.localWrites;
  const localProblem = preparation.durabilityProblem();
  if (localProblem) throw new Error(localProblem);
  await preparation.reconcile();
  const reconciledProblem = preparation.durabilityProblem();
  if (reconciledProblem) throw new Error(reconciledProblem);
  if ((await preparation.queuedMutationCount()) > 0) {
    throw new Error(
      "The source plan still has unsynced edits. Reconnect and wait for Saved before copying it.",
    );
  }
}

/**
 * Server copies this tab received and has not edited since, keyed by year with
 * the server revision they were read at. Only these may be vouched for in a
 * version-aware sync: a year with any local edit is dropped from the map, so a
 * locally projected plan is never presented as confirmed server data.
 */
export type ConfirmedServerPlans = Map<
  number,
  { revision: string; plan: StoredPlan }
>;

export function knownPlanRevisions(
  confirmed: ConfirmedServerPlans,
): PlanRevision[] {
  return [...confirmed].map(([year, { revision }]) => ({ year, revision }));
}

/**
 * Records which published years are the server's own copy. A published year
 * whose `updatedAt` differs from the server copy came from elsewhere (a newer
 * cached snapshot) and is not confirmed.
 */
export function confirmPublishedPlans(
  confirmed: ConfirmedServerPlans,
  published: readonly StoredPlan[],
  serverPlans: readonly StoredPlan[],
  revisions: readonly PlanRevision[] | undefined,
): void {
  const revisionByYear = new Map(
    (revisions ?? []).map(({ year, revision }) => [year, revision]),
  );
  for (const server of serverPlans) {
    const shown = published.find(({ year }) => year === server.year);
    const revision = revisionByYear.get(server.year);
    if (shown && revision && shown.updatedAt === server.updatedAt)
      confirmed.set(server.year, { revision, plan: shown });
    else confirmed.delete(server.year);
  }
}

/**
 * Rebuilds the complete server answer from a partial one. Returns `null` when
 * an omitted year is no longer held here, so the caller must recover with a
 * complete snapshot instead of trusting whatever its cache now contains.
 */
export function completeServerPlans(
  plans: readonly StoredPlan[],
  unchangedYears: readonly number[] | undefined,
  confirmed: ConfirmedServerPlans,
): StoredPlan[] | null {
  if (!unchangedYears) return [...plans];
  const reused: StoredPlan[] = [];
  for (const year of unchangedYears) {
    const held = confirmed.get(year);
    if (!held) return null;
    reused.push(held.plan);
  }
  return [...plans, ...reused].toSorted(
    (left, right) => left.year - right.year,
  );
}
