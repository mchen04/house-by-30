import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { storedPlan } from "@/test/fixtures/plans";
import { DEFAULT_BENEFITS, DEFAULT_EXPENSES } from "./defaults";
import {
  applyDecodedSyncMutation,
  applyDecodedSyncMutations,
  decodeSyncMutation,
  type DecodedSyncMutation,
} from "./sync-decoder";
import { syncMutationSchema, type SyncMutation } from "./sync";

describe("sync decoder", () => {
  it("canonicalizes whole expense values once at the validated boundary", () => {
    const categoryId = "00000000-0000-4000-8000-000000000101";
    const mutation = decodeSyncMutation(
      syncMutationSchema.parse({
        mutationId: "00000000-0000-4000-8000-000000000102",
        planYear: 2026,
        field: `expense:${categoryId}`,
        value: {
          id: categoryId,
          name: "Rent",
          group: "Housing",
          cadence: "monthly",
          amountCents: 200_000,
          sortOrder: 0,
        },
        updatedAt: "2026-07-24T12:00:00.000Z",
      }),
    );

    expect(mutation).toMatchObject({
      kind: "expense",
      property: null,
      value: {
        guidanceBucket: "needs",
        colorToken: "blue",
        archived: false,
      },
    });

    const applied = applyDecodedSyncMutation(storedPlan(), mutation);
    expect(applied.expenses).toContainEqual(
      expect.objectContaining({
        id: categoryId,
        guidanceBucket: "needs",
        colorToken: "blue",
        archived: false,
      }),
    );
  });
});

const ids = (prefix: string) =>
  [1, 2, 3].map(
    (n) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(9, "0")}`,
  );
const BENEFIT_IDS = ids("100");
const EXPENSE_IDS = ids("200");
const TRANSACTION_IDS = ids("300");
const STAMP = "2026-07-24T12:00:00.000Z";

const label = fc.constantFrom("Rent", "Groceries", "Coffee", "Gift");
const cents = fc.integer({ min: 1, max: 5_000_000 });
const date = fc
  .integer({ min: 1, max: 28 })
  .map((day) => `2026-03-${String(day).padStart(2, "0")}`);

const benefitValue = (id: string) =>
  fc
    .record({ label, ratePpm: fc.integer({ min: 0, max: 100_000 }) })
    .map(({ label, ratePpm }) => ({
      ...DEFAULT_BENEFITS[0],
      id,
      label,
      amount: { kind: "percent" as const, ratePpm },
    }));
const expenseValue = (id: string) =>
  fc
    .record({ name: label, amountCents: cents })
    .map(({ name, amountCents }) => ({
      ...DEFAULT_EXPENSES[0],
      id,
      name,
      amountCents,
    }));
const transactionValue = (id: string) =>
  fc
    .record({
      categoryId: fc.constantFrom(...EXPENSE_IDS),
      amountCents: cents,
      title: label,
      date,
    })
    .map((value) => ({ id, ...value, createdAt: STAMP, updatedAt: STAMP }));

const wireMutation: fc.Arbitrary<Omit<SyncMutation, "mutationId">> = fc.oneof(
  fc.record({ field: fc.constant("grossSalaryCents"), value: cents }),
  fc.record({
    field: fc.constant("stateCode"),
    value: fc.constantFrom("CA", "NY", "TX"),
  }),
  fc.record({
    field: fc.constant("startingSavingsCents"),
    value: fc.option(cents, { nil: null }),
  }),
  fc.constantFrom(...BENEFIT_IDS).chain((id) =>
    fc.oneof(
      fc.record({
        field: fc.constant(`benefit:${id}`),
        value: fc.option(benefitValue(id), { nil: null }),
      }),
      fc.record({ field: fc.constant(`benefit:${id}:label`), value: label }),
      fc.record({
        field: fc.constant(`benefit:${id}:amount`),
        value: cents.map((value) => ({ kind: "fixedAnnual", cents: value })),
      }),
    ),
  ),
  fc.constantFrom(...EXPENSE_IDS).chain((id) =>
    fc.oneof(
      fc.record({
        field: fc.constant(`expense:${id}`),
        value: fc.option(expenseValue(id), { nil: null }),
      }),
      fc.record({ field: fc.constant(`expense:${id}:name`), value: label }),
      fc.record({
        field: fc.constant(`expense:${id}:amountCents`),
        value: cents,
      }),
      fc.record({
        field: fc.constant(`expense:${id}:archived`),
        value: fc.boolean(),
      }),
      fc.record({
        field: fc.constant(`expense:${id}:guidanceBucket`),
        value: fc.constantFrom(null, "wants"),
      }),
    ),
  ),
  fc.constantFrom(...TRANSACTION_IDS).chain((id) =>
    fc.oneof(
      fc.record({
        field: fc.constant(`transaction:${id}`),
        value: fc.option(transactionValue(id), { nil: null }),
      }),
      fc.record({
        field: fc.constant(`transaction:${id}:title`),
        value: label,
      }),
      fc.record({
        field: fc.constant(`transaction:${id}:amountCents`),
        value: cents,
      }),
      fc.record({
        field: fc.constant(`transaction:${id}:note`),
        value: fc.option(label, { nil: null }),
      }),
      fc.record({
        field: fc.constant(`transaction:${id}:date`),
        value: date,
      }),
    ),
  ),
) as fc.Arbitrary<Omit<SyncMutation, "mutationId">>;

const decodedBatch = fc.array(wireMutation, { maxLength: 40 }).map((wire) =>
  wire.flatMap((mutation, index): DecodedSyncMutation[] => {
    try {
      return [
        decodeSyncMutation({
          ...mutation,
          mutationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          planYear: 2026,
          updatedAt: STAMP,
        } as SyncMutation),
      ];
    } catch {
      return [];
    }
  }),
);

describe("batch projection", () => {
  it("equals applying each mutation to a fresh copy, in order", () => {
    fc.assert(
      fc.property(decodedBatch, decodedBatch, (seed, batch) => {
        const start = applyDecodedSyncMutations(storedPlan(), seed);
        const sequential = batch.reduce(
          (plan, mutation) => applyDecodedSyncMutation(plan, mutation),
          start,
        );
        expect(applyDecodedSyncMutations(start, batch)).toEqual(sequential);
      }),
      { numRuns: 500 },
    );
  });

  it("leaves the input plan and every mutation untouched, now and after later edits", () => {
    fc.assert(
      fc.property(decodedBatch, decodedBatch, (seed, batch) => {
        const start = applyDecodedSyncMutations(storedPlan(), seed);
        const startBefore = structuredClone(start);
        const batchBefore = structuredClone(batch);
        const result = applyDecodedSyncMutations(start, batch);
        for (const entry of [
          ...result.benefits,
          ...result.expenses,
          ...result.transactions,
        ]) {
          Object.assign(entry, { label: "x", name: "x", title: "x" });
          if ("amount" in entry) entry.amount.kind = "fixedMonthly";
        }
        expect(start).toEqual(startBefore);
        expect(batch).toEqual(batchBefore);
      }),
      { numRuns: 300 },
    );
  });
});
