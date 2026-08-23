"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { User } from "@/domain/api-contracts";
import type { SelectedPeriod } from "@/domain/daily-money";
import type { PlanResult } from "@/domain/tax/engine";
import { BackPage } from "./cockpit-back-page";
import {
  ActivitySurface,
  BudgetSurface,
  CategoryDetailSurface,
  EditBudgetSurface,
  HomeSurface,
  ManageCategoriesSurface,
  MonthlyWrapSurface,
  PlanHub,
} from "./daily-cockpit";
import {
  currentHsaFamilyAllocation,
  type HsaFamilyAllocation,
} from "./hsa-controls";
import { PlanScreen } from "./plan-screen";
import type {
  SaveState,
  Screen,
  StoredPlan,
  TabScreen,
  WorkspaceRoute,
} from "./plan-types";

/** Account is the one secondary surface reachable from all four tabs, so its
 *  back control names whichever one the reader came from. */
const tabLabels: Record<TabScreen, string> = {
  home: "Home",
  budget: "Budget",
  activity: "Activity",
  plan: "Plan",
};

const loadAccountScreen = () => import("./account-screen");
const loadBenefitsScreen = () => import("./benefits-screen");
const loadCompareScreen = () => import("./compare-screen");

const AccountScreen = dynamic(() =>
  loadAccountScreen().then(({ AccountScreen }) => AccountScreen),
);
const BenefitsScreen = dynamic(() =>
  loadBenefitsScreen().then(({ BenefitsScreen }) => BenefitsScreen),
);
const CompareScreen = dynamic(() =>
  loadCompareScreen().then(({ CompareScreen }) => CompareScreen),
);

export async function preloadSecondaryScreens(): Promise<void> {
  await Promise.allSettled([
    loadAccountScreen(),
    loadBenefitsScreen(),
    loadCompareScreen(),
  ]);
}

export function PlanWorkspaceContent({
  today,
  user,
  plans,
  draft,
  route,
  saveState,
  planAwaitingAuthority,
  result,
  period,
  onPeriod,
  onYear,
  onDraft,
  onNavigate,
  onOpenTransaction,
  canCreateExpense,
  onLogout,
  onDeleteAccount,
}: {
  today: string;
  user: User;
  plans: StoredPlan[];
  draft: StoredPlan;
  route: WorkspaceRoute;
  saveState: SaveState;
  planAwaitingAuthority: boolean;
  result: PlanResult;
  period: SelectedPeriod;
  onPeriod: (period: SelectedPeriod) => void;
  onYear: (year: number) => void;
  onDraft: (plan: StoredPlan) => void;
  onNavigate: (route: WorkspaceRoute) => void;
  onOpenTransaction: (transactionId?: string) => void;
  canCreateExpense: boolean;
  onLogout: () => Promise<void>;
  onDeleteAccount: () => Promise<void>;
}) {
  const [hsaAllocationIntents, setHsaAllocationIntents] = useState(
    () => new Map<string, HsaFamilyAllocation>(),
  );
  /* The three cockpit surfaces choose the plan year on their own period row,
     so they are handed the same year list the top bar renders for every other
     screen. See `periodScreens` in `plan-workspace.tsx`. */
  const planYear = { years: plans.map((plan) => plan.year), onYear };
  const preferredHsaAllocation =
    currentHsaFamilyAllocation(draft) ?? hsaAllocationIntents.get(draft.id);
  const navigateScreen = (screen: Screen) => {
    if (
      screen === "category" ||
      screen === "edit-budget" ||
      screen === "wrap" ||
      screen === "account"
    )
      throw new Error(`${screen} requires route context`);
    onNavigate({ screen });
  };
  const rememberHsaAllocation = (allocation: HsaFamilyAllocation) => {
    setHsaAllocationIntents((current) => {
      const next = new Map(current);
      next.set(draft.id, allocation);
      return next;
    });
  };

  switch (route.screen) {
    case "home":
      return (
        <HomeSurface
          today={today}
          plan={draft}
          result={result}
          period={period}
          planYear={planYear}
          // Awaiting the server's answer is not the settled offline state, and
          // the compact offline layout is a different box. Keeping the full
          // layout through the reserved window is what makes the swap to the
          // settled value a zero-shift swap.
          compactForOffline={saveState === "offline" && !planAwaitingAuthority}
          awaitingAuthority={planAwaitingAuthority}
          onPeriod={onPeriod}
          onScreen={(screen) => {
            if (screen === "wrap") {
              onNavigate({ screen, returnTo: "home" });
              return;
            }
            navigateScreen(screen);
          }}
          onCategory={(categoryId) =>
            onNavigate({ screen: "category", categoryId })
          }
          onEditTransaction={onOpenTransaction}
        />
      );
    case "budget":
      return (
        <BudgetSurface
          today={today}
          plan={draft}
          period={period}
          planYear={planYear}
          awaitingAuthority={planAwaitingAuthority}
          onPeriod={onPeriod}
          onScreen={(screen) => {
            if (screen === "edit-budget") {
              onNavigate({ screen, returnTo: "budget" });
              return;
            }
            navigateScreen(screen);
          }}
          onCategory={(categoryId) =>
            onNavigate({ screen: "category", categoryId })
          }
        />
      );
    case "activity":
      return (
        <ActivitySurface
          today={today}
          plan={draft}
          period={period}
          planYear={planYear}
          onPeriod={onPeriod}
          onEdit={onOpenTransaction}
          onWrap={() => onNavigate({ screen: "wrap", returnTo: "activity" })}
          onFastLog={canCreateExpense ? () => onOpenTransaction() : undefined}
        />
      );
    case "category":
      return (
        <CategoryDetailSurface
          today={today}
          plan={draft}
          categoryId={route.categoryId}
          period={period}
          onBack={() => onNavigate({ screen: "budget" })}
          onEdit={onOpenTransaction}
        />
      );
    case "edit-budget":
      return (
        <EditBudgetSurface
          plan={draft}
          onDraft={onDraft}
          onBack={() => onNavigate({ screen: route.returnTo })}
        />
      );
    case "manage-categories":
      return (
        <ManageCategoriesSurface
          plan={draft}
          onDraft={onDraft}
          onBack={() => onNavigate({ screen: "budget" })}
        />
      );
    case "wrap":
      return (
        <MonthlyWrapSurface
          today={today}
          plan={draft}
          result={result}
          period={period}
          backTo={route.returnTo}
          onBack={() => onNavigate({ screen: route.returnTo })}
        />
      );
    case "plan":
      return (
        <PlanHub
          today={today}
          plan={draft}
          result={result}
          onScreen={(screen) => {
            if (screen === "edit-budget") {
              onNavigate({ screen, returnTo: "plan" });
              return;
            }
            navigateScreen(screen);
          }}
          onDraft={onDraft}
        />
      );
    case "plan-details":
      return (
        <BackPage
          title="Plan details"
          backLabel="Plan"
          onBack={() => onNavigate({ screen: "plan" })}
        >
          <PlanScreen
            draft={draft}
            result={result}
            onDraft={onDraft}
            preferredHsaAllocation={preferredHsaAllocation}
            onHsaAllocationIntent={rememberHsaAllocation}
          />
        </BackPage>
      );
    case "benefits":
      return (
        <BackPage
          title="Benefits"
          backLabel="Plan"
          onBack={() => onNavigate({ screen: "plan" })}
        >
          <BenefitsScreen draft={draft} result={result} onDraft={onDraft} />
        </BackPage>
      );
    case "compare":
      return (
        <BackPage
          title="Compare years"
          backLabel="Plan"
          onBack={() => onNavigate({ screen: "plan" })}
        >
          <CompareScreen plans={plans} />
        </BackPage>
      );
    case "account":
      return (
        <BackPage
          title="Account and data"
          backLabel={tabLabels[route.returnTo]}
          onBack={() => onNavigate({ screen: route.returnTo })}
        >
          <AccountScreen
            user={user}
            plans={plans}
            onLogout={onLogout}
            onDeleteAccount={onDeleteAccount}
          />
        </BackPage>
      );
  }
}
