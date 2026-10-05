import { z } from "zod";
import type { BenefitEntry, ConfiguredAmount, TaxTreatment } from "./benefits";
import {
  canonicalBudgetCategory,
  type BudgetCategory,
  type CategoryColorToken,
  type TransactionEntry,
} from "./budget";
import {
  benefitSchema,
  benefitOwnerSchema,
  categoryColorTokenSchema,
  configuredAmountSchema,
  entryLabelSchema,
  esppDiscountRateSchema,
  expenseCadenceSchema,
  expenseGuidanceBucketSchema,
  expenseSchema,
  expenseSortOrderSchema,
  localCalendarDateSchema,
  safeNonnegativeCentsSchema,
  taxTreatmentSchema,
  transactionSchema,
} from "./plan-schema";
import type { StoredPlan } from "./stored-plan";
import type { SyncMutation } from "./sync";
import type { SyncTarget } from "./sync-field";

export type MutationMetadata = Omit<SyncMutation, "field" | "value">;

type EntityMutation<
  K extends "benefit" | "expense" | "transaction",
  P extends string | null,
  V,
> = MutationMetadata & {
  kind: K;
  field: SyncMutation["field"];
  entityId: string;
  property: P;
  value: V;
};

export type DecodedBenefitMutation =
  | EntityMutation<"benefit", null, BenefitEntry | null>
  | EntityMutation<"benefit", "owner", BenefitEntry["owner"]>
  | EntityMutation<"benefit", "label", string>
  | EntityMutation<"benefit", "amount", ConfiguredAmount>
  | EntityMutation<"benefit", "discountRatePpm", number | null>
  | EntityMutation<"benefit", "customTaxTreatment", TaxTreatment | null>;

export type DecodedExpenseMutation =
  | EntityMutation<"expense", null, BudgetCategory | null>
  | EntityMutation<"expense", "name" | "group", string>
  | EntityMutation<"expense", "cadence", BudgetCategory["cadence"]>
  | EntityMutation<"expense", "amountCents", number>
  | EntityMutation<"expense", "sortOrder", number>
  | EntityMutation<
      "expense",
      "guidanceBucket",
      BudgetCategory["guidanceBucket"] | undefined
    >
  | EntityMutation<"expense", "colorToken", CategoryColorToken>
  | EntityMutation<"expense", "archived", boolean>;

export type DecodedTransactionMutation =
  | EntityMutation<"transaction", null, TransactionEntry | null>
  | EntityMutation<"transaction", "categoryId", string>
  | EntityMutation<"transaction", "amountCents", number>
  | EntityMutation<"transaction", "title", string>
  | EntityMutation<"transaction", "note", string | undefined>
  | EntityMutation<"transaction", "date", string>
  | EntityMutation<"transaction", "updatedAt", string>;

export type DecodedEntityMutation =
  DecodedBenefitMutation | DecodedExpenseMutation | DecodedTransactionMutation;

type EntitySyncTarget = Exclude<SyncTarget, { kind: "scalar" }>;

export function decodeEntitySyncMutation(
  mutation: SyncMutation,
  target: EntitySyncTarget,
  base: MutationMetadata,
): DecodedEntityMutation {
  const common = {
    ...base,
    kind: target.kind,
    field: mutation.field,
    entityId: target.id,
  };
  if (target.kind === "benefit") {
    if (!target.property) {
      const value =
        mutation.value === null ? null : benefitSchema.parse(mutation.value);
      if (value && value.id !== target.id)
        throw new Error("Benefit mutation ID mismatch");
      return { ...common, kind: target.kind, property: null, value };
    }
    switch (target.property) {
      case "owner":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value:
            mutation.value === null
              ? undefined
              : benefitOwnerSchema.parse(mutation.value),
        };
      case "label":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: entryLabelSchema.parse(mutation.value),
        };
      case "amount":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: configuredAmountSchema.parse(mutation.value),
        };
      case "discountRatePpm":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value:
            mutation.value === null
              ? null
              : esppDiscountRateSchema.parse(mutation.value),
        };
      case "customTaxTreatment":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value:
            mutation.value === null
              ? null
              : taxTreatmentSchema.parse(mutation.value),
        };
    }
  }
  if (target.kind === "expense") {
    if (!target.property) {
      const value =
        mutation.value === null
          ? null
          : canonicalBudgetCategory(expenseSchema.parse(mutation.value));
      if (value && value.id !== target.id)
        throw new Error("Expense mutation ID mismatch");
      return { ...common, kind: target.kind, property: null, value };
    }
    switch (target.property) {
      case "name":
      case "group":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: entryLabelSchema.parse(mutation.value),
        };
      case "cadence":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: expenseCadenceSchema.parse(mutation.value),
        };
      case "amountCents":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: safeNonnegativeCentsSchema.parse(mutation.value),
        };
      case "sortOrder":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: expenseSortOrderSchema.parse(mutation.value),
        };
      case "guidanceBucket":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value:
            mutation.value === null
              ? undefined
              : expenseGuidanceBucketSchema.parse(mutation.value),
        };
      case "colorToken":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: categoryColorTokenSchema.parse(mutation.value),
        };
      case "archived":
        return {
          ...common,
          kind: target.kind,
          property: target.property,
          value: z.boolean().parse(mutation.value),
        };
    }
  }
  if (!target.property) {
    const value =
      mutation.value === null ? null : transactionSchema.parse(mutation.value);
    if (value && value.id !== target.id)
      throw new Error("Transaction mutation ID mismatch");
    return { ...common, kind: target.kind, property: null, value };
  }
  switch (target.property) {
    case "categoryId":
      return {
        ...common,
        kind: target.kind,
        property: target.property,
        value: z.uuid().parse(mutation.value),
      };
    case "amountCents":
      return {
        ...common,
        kind: target.kind,
        property: target.property,
        value: safeNonnegativeCentsSchema.positive().parse(mutation.value),
      };
    case "title":
      return {
        ...common,
        kind: target.kind,
        property: target.property,
        value: entryLabelSchema.parse(mutation.value),
      };
    case "note":
      return {
        ...common,
        kind: target.kind,
        property: target.property,
        value:
          mutation.value === null
            ? undefined
            : z.string().max(500).parse(mutation.value),
      };
    case "date":
      return {
        ...common,
        kind: target.kind,
        property: target.property,
        value: localCalendarDateSchema.parse(mutation.value),
      };
    case "updatedAt":
      return {
        ...common,
        kind: target.kind,
        property: target.property,
        value: z.iso.datetime().parse(mutation.value),
      };
  }
}

/**
 * Applies the mutation to a plan the caller exclusively owns. Values are copied
 * on the way in, so later in-place edits never reach back into the mutation.
 */
export function applyDecodedEntityMutationInPlace(
  next: StoredPlan,
  mutation: DecodedEntityMutation,
): void {
  if (mutation.kind === "benefit") {
    const index = next.benefits.findIndex(
      (entry) => entry.id === mutation.entityId,
    );
    if (mutation.property === null) {
      if (mutation.value === null) {
        if (index >= 0) next.benefits.splice(index, 1);
      } else if (index >= 0)
        next.benefits[index] = structuredClone(mutation.value);
      else next.benefits.push(structuredClone(mutation.value));
      return;
    }
    if (index < 0) return;
    const entry = next.benefits[index];
    switch (mutation.property) {
      case "owner":
        entry.owner = mutation.value;
        break;
      case "label":
        entry.label = mutation.value;
        break;
      case "amount":
        entry.amount = structuredClone(mutation.value);
        break;
      case "discountRatePpm":
        entry.discountRatePpm = mutation.value ?? undefined;
        break;
      case "customTaxTreatment":
        entry.customTaxTreatment = structuredClone(mutation.value) ?? undefined;
        break;
    }
    return;
  }
  if (mutation.kind === "expense") {
    const index = next.expenses.findIndex(
      (entry) => entry.id === mutation.entityId,
    );
    if (mutation.property === null) {
      if (mutation.value === null) {
        if (index >= 0) next.expenses.splice(index, 1);
      } else if (index >= 0)
        next.expenses[index] = structuredClone(mutation.value);
      else next.expenses.push(structuredClone(mutation.value));
      return;
    }
    if (index < 0) return;
    const entry = next.expenses[index];
    switch (mutation.property) {
      case "name":
        entry.name = mutation.value;
        break;
      case "group":
        entry.group = mutation.value;
        break;
      case "cadence":
        entry.cadence = mutation.value;
        break;
      case "amountCents":
        entry.amountCents = mutation.value;
        break;
      case "sortOrder":
        entry.sortOrder = mutation.value;
        break;
      case "guidanceBucket":
        entry.guidanceBucket =
          mutation.value ??
          canonicalBudgetCategory({
            ...entry,
            guidanceBucket: undefined,
          }).guidanceBucket;
        break;
      case "colorToken":
        entry.colorToken = mutation.value;
        break;
      case "archived":
        entry.archived = mutation.value;
        break;
    }
    return;
  }
  const index = next.transactions.findIndex(
    (entry) => entry.id === mutation.entityId,
  );
  if (mutation.property === null) {
    if (mutation.value === null) {
      if (index >= 0) next.transactions.splice(index, 1);
    } else if (index >= 0)
      next.transactions[index] = structuredClone(mutation.value);
    else next.transactions.push(structuredClone(mutation.value));
    return;
  }
  if (index < 0) return;
  const entry = next.transactions[index];
  switch (mutation.property) {
    case "categoryId":
      entry.categoryId = mutation.value;
      break;
    case "amountCents":
      entry.amountCents = mutation.value;
      break;
    case "title":
      entry.title = mutation.value;
      break;
    case "note":
      entry.note = mutation.value;
      break;
    case "date":
      entry.date = mutation.value;
      break;
    case "updatedAt":
      entry.updatedAt = mutation.value;
      break;
  }
}
