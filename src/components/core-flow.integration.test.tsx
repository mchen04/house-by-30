/** @vitest-environment jsdom */

import "fake-indexeddb/auto";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/domain/api-contracts";
import type { StoredPlan } from "@/domain/stored-plan";
import {
  cachedPlans,
  clearAccountCache,
  clearRememberedUser,
  queuedMutations,
} from "@/offline/database";
import { storedPlan } from "@/test/fixtures/plans";
import { PlanWorkspace } from "./plan-workspace";
import {
  applyDraftChange,
  replacePlanIntent,
  type PlanDraftChange,
} from "./sync-state";
import { useAccountLifecycle } from "./use-account-lifecycle";
import { usePlanSession, type PlanSessionController } from "./use-plan-session";
import { usePlanSync, type PlanSyncController } from "./use-plan-sync";
import type { WorkspaceLocation } from "./plan-types";

const jsonRequest = vi.hoisted(() => vi.fn());

vi.mock("./plan-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plan-types")>()),
  jsonRequest,
}));

const user: User = {
  id: "flow-user",
  email: "flow@example.com",
  sessionId: "00000000-0000-4000-8000-000000000010",
};
const categoryId = "00000000-0000-4000-8000-000000000101";
const baseline = storedPlan(2026, {
  expenses: [
    {
      id: categoryId,
      name: "Rent",
      group: "Housing",
      cadence: "monthly",
      amountCents: 100_000,
      sortOrder: 0,
      guidanceBucket: "needs",
      colorToken: "blue",
      archived: false,
    },
  ],
  transactions: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      categoryId,
      amountCents: 10_000,
      title: "January rent",
      date: "2026-01-15",
      createdAt: "2026-01-15T12:00:00.000Z",
      updatedAt: "2026-01-15T12:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      categoryId,
      amountCents: 25_000,
      title: "July rent",
      date: "2026-07-01",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    },
  ],
});

function lockManager(): Pick<LockManager, "request"> {
  const tails = new Map<string, Promise<void>>();
  const request = async <T,>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> => {
    const callback =
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback!;
    const options =
      typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const prior = tails.get(name) ?? Promise.resolve();
    let release: () => void = () => undefined;
    tails.set(
      name,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      await prior;
      options?.signal?.throwIfAborted();
      return await callback({ name, mode: "exclusive" });
    } finally {
      release();
    }
  };
  return { request: request as LockManager["request"] };
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function fill(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(container: ParentNode, label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function WorkspaceHarness({
  initialPlan,
  onPlan,
}: {
  initialPlan: StoredPlan;
  onPlan: (plan: StoredPlan) => void;
}) {
  const [plan, setPlan] = useState(initialPlan);
  const [location, setLocation] = useState<WorkspaceLocation>({
    route: { screen: "home" },
  });
  const accept = (change: PlanDraftChange) =>
    setPlan((current) => {
      const next = applyDraftChange(current, change);
      onPlan(next);
      return next;
    });
  return (
    <PlanWorkspace
      today="2026-07-24"
      user={user}
      plans={[plan]}
      draft={plan}
      location={location}
      saveState="saved"
      planAwaitingAuthority={false}
      onLocation={setLocation}
      onDraft={accept}
      onYear={vi.fn()}
      onCopyForward={vi.fn()}
      onRetryLocalSave={vi.fn()}
      onRetrySync={vi.fn()}
      onLogout={vi.fn()}
      onDeleteAccount={vi.fn()}
    />
  );
}

interface MountedSync {
  session: PlanSessionController;
  sync: PlanSyncController;
}

function LifecycleHarness({
  expose,
}: {
  expose: (value: MountedSync) => void;
}) {
  const session = usePlanSession();
  const sync = usePlanSync(session);
  const account = useAccountLifecycle(session, sync);
  const { beginPlanIntent, runtimeRef, setDraft, setPlans } = session;
  useEffect(() => expose({ session, sync }), [expose, session, sync]);
  if (session.phase !== "ready" || !session.user || !session.draft)
    return <p data-phase={session.phase}>{session.phase}</p>;
  return (
    <PlanWorkspace
      today="2026-07-24"
      user={session.user}
      plans={session.plans}
      draft={session.draft}
      location={session.location}
      saveState={session.saveState}
      planAwaitingAuthority={session.planAwaitingAuthority}
      onLocation={session.setLocation}
      onDraft={(change) => {
        const current =
          runtimeRef.current.plans.find(
            ({ year }) => year === session.draft?.year,
          ) ?? session.draft!;
        const next = applyDraftChange(current, change);
        if (next === current) return;
        beginPlanIntent();
        const plans = replacePlanIntent(runtimeRef.current.plans, next);
        runtimeRef.current.plans = plans;
        setPlans(plans);
        setDraft(next);
      }}
      onYear={vi.fn()}
      onCopyForward={vi.fn()}
      onRetryLocalSave={() => void sync.retryDeviceSave()}
      onRetrySync={() => void sync.retrySync()}
      onLogout={() => account.closeAccount(false)}
      onDeleteAccount={() => account.closeAccount(true)}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settleUntil(
  predicate: () => boolean,
  message: string,
  attempts = 80,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

describe("daily cockpit integration contract", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: lockManager(),
    });
    await clearRememberedUser();
    await clearAccountCache(user.id);
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    document.cookie = "kyle_cache_owner=; Max-Age=0; Path=/";
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await clearRememberedUser();
    await clearAccountCache(user.id);
    document.cookie = "kyle_cache_owner=; Max-Age=0; Path=/";
    vi.unstubAllGlobals();
    delete (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT;
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it("renders a returning user, Fast Logs durably shaped data, and reconciles every period with Wrap", () => {
    let latest = baseline;
    act(() => {
      root.render(
        <WorkspaceHarness
          initialPlan={baseline}
          onPlan={(plan) => {
            latest = plan;
          }}
        />,
      );
    });

    expect(container.querySelector("main h1")?.textContent).toBe("Home");
    expect(container.textContent).toContain(
      "exact: $1,000.00 − $250.00 = $750.00",
    );

    click(button(container, "Fast Log expense"));
    const amount = container.querySelector<HTMLInputElement>(
      'input[placeholder="0.00"]',
    )!;
    const title = [
      ...container.querySelectorAll<HTMLInputElement>("input"),
    ].find((input) =>
      input.closest("label")?.textContent?.includes("What was it?"),
    )!;
    fill(amount, "12.34");
    fill(title, "Integration coffee");
    click(button(container, "Save expense"));

    expect(latest.transactions).toHaveLength(3);
    expect(latest.transactions.at(-1)).toMatchObject({
      amountCents: 1_234,
      title: "Integration coffee",
    });
    expect(container.textContent).toContain("Integration coffee");

    click(button(container, "YTD"));
    expect(container.textContent).toContain(
      "exact: $7,000.00 − $362.34 = $6,637.66",
    );
    click(button(container, "Year"));
    expect(container.textContent).toContain(
      "exact: $12,000.00 − $362.34 = $11,637.66",
    );
    click(button(container, "Month"));
    click(
      [...container.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes("Monthly wrap"),
      )!,
    );
    expect(container.textContent).toContain("July 2026 wrap");
    expect(container.textContent).toContain("Budget versus actual");
    expect(container.textContent).toContain("$1,000");
    expect(container.textContent).toContain("$262");
    expect(container.textContent).toContain("+$738");

    // The wrap was opened from Home, so its single back control names Home and
    // returns there. It is also reachable from Activity, which returns there.
    click(button(container, "Back to Home"));
    expect(container.querySelector("main h1")?.textContent).toBe("Home");
    click(button(container, "Budget"));
    click(button(container, "Edit budget"));
    const rentAmount = container.querySelector<HTMLInputElement>(
      '[aria-label="Rent planned amount"]',
    )!;
    // An edit in flight is the reader's, not the plan's: the box shows exactly
    // what was typed and the plan is untouched until the edit ends. "1." is the
    // case that used to make that visible — it parses to a *different* number
    // than the string shown — and it is now simply not persisted yet.
    const rentBeforeEdit = latest.expenses[0].amountCents;
    fill(rentAmount, "1.");
    expect(rentAmount.value).toBe("1.");
    expect(latest.expenses[0].amountCents).toBe(rentBeforeEdit);
    act(() =>
      rentAmount.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    expect(latest.expenses[0].amountCents).toBe(100);
    expect(rentAmount.value).toBe("1");

    click(button(container, "Plan"));
    const startingSavings = container.querySelector<HTMLInputElement>(
      'input[placeholder="Optional"]',
    )!;
    fill(startingSavings, "1.");
    expect(startingSavings.value).toBe("1.");
    expect(latest.startingSavingsCents).toBeUndefined();
    act(() =>
      startingSavings.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      ),
    );
    expect(latest.startingSavingsCents).toBe(100);
    expect(startingSavings.value).toBe("1");

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(
        <WorkspaceHarness initialPlan={latest} onPlan={() => undefined} />,
      );
    });
    expect(container.textContent).toContain("Integration coffee");
  });

  it("gives the month and the year one row of their own, and never two year controls at once", () => {
    act(() => {
      root.render(
        <WorkspaceHarness initialPlan={baseline} onPlan={() => undefined} />,
      );
    });
    const yearControls = () => [
      ...container.querySelectorAll('[aria-label="Plan year"]'),
    ];

    // The cockpit surfaces choose the year on their period row and every other
    // screen chooses it in the top bar. Both instances exist in the tree, so
    // the only thing keeping the app honest is that they are exclusive.
    for (const tab of ["Home", "Budget", "Activity", "Plan"]) {
      click(button(container, tab));
      expect(yearControls()).toHaveLength(1);
    }
    click(button(container, "Budget"));
    click(button(container, "Manage categories"));
    expect(yearControls()).toHaveLength(1);

    click(button(container, "Home"));
    const row = yearControls()[0].parentElement!;
    expect(row.querySelector('select[aria-label="Month"]')).not.toBeNull();
    // H3: the row belongs to the month and the year. The period-kind tabs are
    // the row above it, not a third control sharing this one.
    expect(row.querySelector("button[aria-pressed]")).toBeNull();
  });

  it("persists an offline UI intent through a cold account restore, then syncs exactly once", async () => {
    let mounted: MountedSync | undefined;
    let bootstrapAvailable = true;
    let serverApplications = 0;
    const deliveredBatches: {
      mutationId: string;
      field: string;
    }[][] = [];

    jsonRequest.mockImplementation(async (url: string, _schema, init) => {
      if (url === "/api/bootstrap") {
        if (!bootstrapAvailable) throw new Error("Network unavailable");
        return { user, plans: [baseline] };
      }
      if (url === "/api/sync") {
        serverApplications += 1;
        const mutations = JSON.parse(String(init?.body)).mutations as {
          mutationId: string;
          field: string;
        }[];
        deliveredBatches.push(mutations);
        return {
          acknowledgements: mutations.map(({ mutationId }) => ({ mutationId })),
          plans: await cachedPlans(user.id),
        };
      }
      if (url === "/api/auth/session") return { user };
      return { plans: [baseline] };
    });

    const mount = async () => {
      act(() => {
        root.render(
          <LifecycleHarness
            expose={(value) => {
              mounted = value;
            }}
          />,
        );
      });
      await settleUntil(
        () => mounted?.session.phase === "ready",
        "ready account lifecycle",
      );
    };

    await mount();
    click(button(container, "Fast Log expense"));
    fill(
      container.querySelector<HTMLInputElement>('input[placeholder="0.00"]')!,
      "5.00",
    );
    const title = [
      ...container.querySelectorAll<HTMLInputElement>("input"),
    ].find((input) =>
      input.closest("label")?.textContent?.includes("What was it?"),
    )!;
    fill(title, "Offline coffee");
    click(button(container, "Create category"));
    const categoryName = [
      ...container.querySelectorAll<HTMLInputElement>("input"),
    ].find((input) =>
      input.closest("label")?.textContent?.includes("New category"),
    )!;
    fill(categoryName, "Coffee");
    click(button(container, "Create"));
    click(button(container, "Save expense"));
    await settleUntil(
      () =>
        mounted?.session.draft?.transactions.some(
          ({ title }) => title === "Offline coffee",
        ) === true,
      "offline transaction render",
    );
    await mounted!.session.runtimeRef.current.localWriteChain;

    expect((await cachedPlans(user.id))[0]).toMatchObject({
      expenses: expect.arrayContaining([
        expect.objectContaining({ name: "Coffee" }),
      ]),
      transactions: expect.arrayContaining([
        expect.objectContaining({ title: "Offline coffee" }),
      ]),
    });
    expect((await queuedMutations(user.id)).map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^expense:/),
        expect.stringMatching(/^transaction:/),
      ]),
    );

    bootstrapAvailable = false;
    act(() => root.unmount());
    root = createRoot(container);
    mounted = undefined;
    jsonRequest.mockClear();
    await mount();
    expect(mounted!.session.saveState).toBe("offline");
    expect(mounted!.session.draft).toMatchObject({
      expenses: expect.arrayContaining([
        expect.objectContaining({ name: "Coffee" }),
      ]),
      transactions: expect.arrayContaining([
        expect.objectContaining({ title: "Offline coffee" }),
      ]),
    });

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    act(() => window.dispatchEvent(new Event("online")));
    await settleUntil(
      () => mounted?.session.runtimeRef.current.reconcileRunning !== null,
      "reconnect orchestration",
    );
    await act(async () => {
      await mounted!.session.runtimeRef.current.reconcileRunning;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    if (mounted!.session.runtimeRef.current.reconcileRunning)
      await act(async () => {
        await mounted!.session.runtimeRef.current.reconcileRunning;
      });
    await settleUntil(
      () => mounted?.session.saveState === "saved",
      "saved reconnect state",
    );

    expect(serverApplications).toBe(1);
    expect(deliveredBatches).toHaveLength(1);
    expect(deliveredBatches[0].map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^expense:/),
        expect.stringMatching(/^transaction:/),
      ]),
    );
    expect(
      new Set(deliveredBatches[0].map(({ mutationId }) => mutationId)).size,
    ).toBe(deliveredBatches[0].length);
    expect(await queuedMutations(user.id)).toEqual([]);
    expect(mounted!.session.saveState).toBe("saved");
    expect(mounted!.session.draft?.transactions).toContainEqual(
      expect.objectContaining({ title: "Offline coffee" }),
    );
  });

  it("paints the matching device cache before a slow bootstrap finishes", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    let mounted: MountedSync | undefined;
    let launch = 0;
    let releaseBootstrap = () => undefined as void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const authoritative = {
      ...baseline,
      grossSalaryCents: baseline.grossSalaryCents + 100_000,
    };

    jsonRequest.mockImplementation(async (url: string) => {
      if (url === "/api/bootstrap") {
        launch += 1;
        if (launch === 1) return { user, plans: [baseline] };
        await bootstrapGate;
        return { user, plans: [authoritative] };
      }
      if (url === "/api/auth/session") return { user };
      return { plans: [baseline] };
    });

    const mount = async () => {
      act(() => {
        root.render(
          <LifecycleHarness
            expose={(value) => {
              mounted = value;
            }}
          />,
        );
      });
    };

    await mount();
    await settleUntil(
      () => mounted?.session.phase === "ready",
      "initial ready account lifecycle",
    );
    document.cookie = `kyle_cache_owner=${user.sessionId}; Path=/; SameSite=Lax`;

    act(() => root.unmount());
    root = createRoot(container);
    mounted = undefined;
    await mount();
    for (let attempt = 0; attempt < 20; attempt += 1) await settle();
    const cachedMount = mounted as MountedSync | undefined;
    const paintedBeforeBootstrap = cachedMount?.session.phase === "ready";
    const cachedSalary = cachedMount?.session.draft?.grossSalaryCents;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(
      jsonRequest.mock.calls.filter(
        ([url]) => url === "/api/plans" || url === "/api/auth/session",
      ),
    ).toHaveLength(0);

    releaseBootstrap();
    await settleUntil(
      () =>
        mounted?.session.draft?.grossSalaryCents ===
        authoritative.grossSalaryCents,
      "authoritative bootstrap",
    );

    expect(paintedBeforeBootstrap).toBe(true);
    expect(cachedSalary).toBe(baseline.grossSalaryCents);
    for (let attempt = 0; attempt < 20; attempt += 1) await settle();
    expect(
      jsonRequest.mock.calls.filter(([url]) => url === "/api/auth/session"),
    ).toHaveLength(0);
  });

  it("does not paint a private cache owned by another session", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    let mounted: MountedSync | undefined;
    let launch = 0;
    let releaseBootstrap = () => undefined as void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const authoritative = {
      ...baseline,
      grossSalaryCents: baseline.grossSalaryCents + 200_000,
    };

    jsonRequest.mockImplementation(async (url: string) => {
      if (url === "/api/bootstrap") {
        launch += 1;
        if (launch === 1) return { user, plans: [baseline] };
        await bootstrapGate;
        return { user, plans: [authoritative] };
      }
      if (url === "/api/auth/session") return { user };
      return { plans: [baseline] };
    });

    const mount = async () => {
      act(() => {
        root.render(
          <LifecycleHarness
            expose={(value) => {
              mounted = value;
            }}
          />,
        );
      });
    };

    await mount();
    await settleUntil(
      () => mounted?.session.phase === "ready",
      "initial ready account lifecycle",
    );
    document.cookie =
      "kyle_cache_owner=00000000-0000-4000-8000-000000000099; Path=/; SameSite=Lax";

    act(() => root.unmount());
    root = createRoot(container);
    mounted = undefined;
    await mount();
    for (let attempt = 0; attempt < 20; attempt += 1) await settle();
    const blockedMount = mounted as MountedSync | undefined;

    expect(blockedMount?.session.phase).toBe("loading");
    expect(blockedMount?.session.draft).toBeNull();

    releaseBootstrap();
    await settleUntil(
      () =>
        mounted?.session.draft?.grossSalaryCents ===
        authoritative.grossSalaryCents,
      "authoritative bootstrap",
    );
  });

  it("reserves the headline while a cache restore waits for the server, and never paints the stale figure", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    let mounted: MountedSync | undefined;
    let bootstrapAvailable = true;
    let releaseRefresh = () => undefined as void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    // The same plan year with a different allocation, so the cached answer
    // ($750 left to spend) and the authoritative answer ($1,750) are different
    // numbers under the identical label — D2's exact shape.
    const authoritative: StoredPlan = {
      ...baseline,
      expenses: [{ ...baseline.expenses[0], amountCents: 200_000 }],
    };

    jsonRequest.mockImplementation(async (url: string) => {
      if (url === "/api/bootstrap") {
        if (!bootstrapAvailable) throw new Error("Network unavailable");
        return { user, plans: [baseline] };
      }
      if (url === "/api/auth/session") return { user };
      if (url === "/api/plans" && !bootstrapAvailable) {
        await refreshGate;
        return { plans: [authoritative] };
      }
      return { plans: [baseline] };
    });

    const mount = async () => {
      act(() => {
        root.render(
          <LifecycleHarness
            expose={(value) => {
              mounted = value;
            }}
          />,
        );
      });
      await settleUntil(
        () => mounted?.session.phase === "ready",
        "ready account lifecycle",
      );
    };

    await mount();
    expect(container.textContent).toContain("$750");
    expect(mounted!.session.planAwaitingAuthority).toBe(false);

    bootstrapAvailable = false;
    act(() => root.unmount());
    root = createRoot(container);
    mounted = undefined;
    await mount();

    // The restore happened and the cached plan is in state, but the reserved
    // box is what is painted: no figure, and the label that would have given a
    // figure its meaning is inside the reservation too.
    expect(mounted!.session.planAwaitingAuthority).toBe(true);
    expect(mounted!.session.draft?.expenses[0].amountCents).toBe(100_000);
    expect(container.querySelector("main")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(container.querySelector("[data-reserved]")).not.toBeNull();
    expect(container.textContent).not.toContain("$750");
    expect(container.textContent).not.toContain("Left to spend");
    // The device is online and fetching, so it does not claim to be offline for
    // the length of the fetch and then take it back.
    expect(container.textContent).not.toContain(
      "Showing the latest copy saved on this device",
    );

    // Budget reserves the same way. Its whole `h1` is the reservation, because
    // the figure and the phrase that gives it meaning are one string.
    click(button(container, "Budget"));
    expect(
      container.querySelector("main h1")?.hasAttribute("data-reserved"),
    ).toBe(true);
    expect(container.querySelector("main h1")?.textContent?.trim()).toBe("");
    expect(container.querySelector("main header p")?.textContent).toBe(
      "Budget",
    );
    expect(container.textContent).not.toContain("left to spend");
    click(button(container, "Home"));

    releaseRefresh();
    await settleUntil(
      () => mounted?.session.planAwaitingAuthority === false,
      "authoritative plan refresh",
    );

    // One step from the reservation to the settled value, with no third state
    // in between.
    expect(container.querySelector("[data-reserved]")).toBeNull();
    expect(
      container.querySelector("main")?.getAttribute("aria-busy"),
    ).toBeNull();
    expect(container.textContent).toContain("Left to spend");
    expect(container.textContent).toContain("$1,750");
    expect(container.textContent).not.toContain("$750 ");
  });

  it("keeps a genuinely offline cached plan rendering its own value", async () => {
    let mounted: MountedSync | undefined;
    let bootstrapAvailable = true;
    jsonRequest.mockImplementation(async (url: string) => {
      if (url === "/api/bootstrap") {
        if (!bootstrapAvailable) throw new Error("Network unavailable");
        return { user, plans: [baseline] };
      }
      if (url === "/api/auth/session") return { user };
      return { plans: [baseline] };
    });
    const mount = async () => {
      act(() => {
        root.render(
          <LifecycleHarness
            expose={(value) => {
              mounted = value;
            }}
          />,
        );
      });
      await settleUntil(
        () => mounted?.session.phase === "ready",
        "ready account lifecycle",
      );
    };

    await mount();
    bootstrapAvailable = false;
    act(() => root.unmount());
    root = createRoot(container);
    mounted = undefined;
    await mount();

    // `navigator.onLine` is false for the whole suite unless a test opts in, so
    // there is no authoritative refresh to wait for. The cached plan *is* the
    // settled value and it renders as one, with no reservation and no busy
    // region.
    expect(mounted!.session.saveState).toBe("offline");
    expect(mounted!.session.planAwaitingAuthority).toBe(false);
    expect(container.querySelector("[data-reserved]")).toBeNull();
    expect(
      container.querySelector("main")?.getAttribute("aria-busy"),
    ).toBeNull();
    expect(container.textContent).toContain("Left to spend");
    expect(container.textContent).toContain("$750");
    // Rule 5's boundary, asserted rather than claimed: a genuinely offline
    // device still gets the offline notice and the retry control it always had.
    expect(container.textContent).toContain(
      "Showing the latest copy saved on this device",
    );
    expect(button(container, "Retry sync")).toBeTruthy();
  });
});
