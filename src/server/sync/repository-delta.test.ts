import { afterAll, describe, expect, it } from "vitest";
import type { PlanRevision } from "@/domain/api-contracts";
import { createUser } from "@/server/auth/repository";
import { listPlanSnapshot } from "@/server/plans/repository";
import { testSql } from "@/test/database";
import { createPlanWithDefaults } from "@/test/plan-repository";
import { applySyncMutations } from "./repository";

const sql = testSql();

afterAll(async () => {
  await sql.end();
});

const basics = (year: number) => ({
  year,
  stateCode: "CA" as const,
  filingStatus: "single" as const,
  grossSalaryCents: 10_000_000,
  additionalWageIncomeCents: 0,
  spouseWageIncomeCents: 0,
  otherOrdinaryIncomeCents: 0,
  hsaCoverage: "self" as const,
});

let sequence = 0;
function salaryEdit(planYear: number, value: number) {
  sequence += 1;
  return {
    mutationId: `00000000-0000-4000-8000-${String(700_000 + sequence).padStart(12, "0")}`,
    planYear,
    field: "grossSalaryCents" as const,
    value,
    updatedAt: new Date(Date.now() - 1_000 + sequence).toISOString(),
  };
}

async function accountWithYears(name: string, years: number[]) {
  const user = await createUser(
    sql,
    `sync-delta-${name}@example.com`,
    `sync delta ${name} password`,
  );
  for (const year of years)
    await createPlanWithDefaults(sql, user.id, basics(year));
  return user;
}

const years = (plans: { year: number }[]) => plans.map(({ year }) => year);

describe("version-aware sync responses", () => {
  it("keeps the complete account answer for a client that sends no revisions", async () => {
    const user = await accountWithYears("legacy", [2061, 2062]);

    const response = await applySyncMutations(sql, user.id, [
      salaryEdit(2061, 10_000_100),
    ]);

    expect(years(response.plans)).toEqual([2061, 2062]);
    expect(response).not.toHaveProperty("unchangedYears");
    expect(years(response.planRevisions)).toEqual([2061, 2062]);
  });

  it("returns the touched year and omits a year the client holds unchanged", async () => {
    const user = await accountWithYears("touched", [2061, 2062]);
    const { planRevisions } = await listPlanSnapshot(sql, user.id);

    const response = await applySyncMutations(
      sql,
      user.id,
      [salaryEdit(2061, 10_000_200)],
      planRevisions,
    );

    expect(years(response.plans)).toEqual([2061]);
    expect(response.plans[0].grossSalaryCents).toBe(10_000_200);
    expect(response.unchangedYears).toEqual([2062]);
  });

  it("returns a year another client changed while this client edited a different one", async () => {
    const user = await accountWithYears("two-clients", [2061, 2062]);
    const held = (await listPlanSnapshot(sql, user.id)).planRevisions;

    // Client B changes 2062 after client A last read it.
    await applySyncMutations(sql, user.id, [salaryEdit(2062, 22_222_200)]);
    // Client A edits 2061, still holding its old 2062 revision.
    const response = await applySyncMutations(
      sql,
      user.id,
      [salaryEdit(2061, 11_111_100)],
      held,
    );

    expect(years(response.plans)).toEqual([2061, 2062]);
    expect(response.plans[1].grossSalaryCents).toBe(22_222_200);
    expect(response.unchangedYears).toEqual([]);
  });

  it("returns the touched year even when the batch applied nothing", async () => {
    const user = await accountWithYears("no-op", [2061, 2062]);
    const edit = salaryEdit(2061, 10_000_300);
    await applySyncMutations(sql, user.id, [edit]);
    const held = (await listPlanSnapshot(sql, user.id)).planRevisions;

    // A replayed mutation is acknowledged again but moves no revision; the
    // client may still hold a projection of it, so the year comes back.
    const replay = await applySyncMutations(sql, user.id, [edit], held);

    expect((await listPlanSnapshot(sql, user.id)).planRevisions).toEqual(held);
    expect(years(replay.plans)).toEqual([2061]);
    expect(replay.unchangedYears).toEqual([2062]);
  });

  it("returns every year whose revision is stale, unknown to the client, or newly created", async () => {
    const user = await accountWithYears("stale", [2061, 2062]);
    const held = (await listPlanSnapshot(sql, user.id)).planRevisions;
    await createPlanWithDefaults(sql, user.id, basics(2063));

    const response = await applySyncMutations(
      sql,
      user.id,
      [salaryEdit(2061, 10_000_400)],
      held.map((entry) =>
        entry.year === 2062 ? { ...entry, revision: "stale" } : entry,
      ),
    );

    expect(years(response.plans)).toEqual([2061, 2062, 2063]);
    expect(response.unchangedYears).toEqual([]);
  });

  it("answers completely when the client claims a year the account does not have", async () => {
    const user = await accountWithYears("missing-year", [2061, 2062]);
    const held = (await listPlanSnapshot(sql, user.id)).planRevisions;

    const response = await applySyncMutations(
      sql,
      user.id,
      [salaryEdit(2061, 10_000_500)],
      [...held, { year: 2099, revision: "1:1" }],
    );

    expect(years(response.plans)).toEqual([2061, 2062]);
    expect(response.unchangedYears).toEqual([]);
  });

  it("never returns or omits another account's years on the strength of its revisions", async () => {
    const owner = await accountWithYears("isolation-owner", [2061, 2062]);
    const other = await accountWithYears("isolation-other", [2061, 2062]);
    const othersRevisions: PlanRevision[] = (
      await listPlanSnapshot(sql, other.id)
    ).planRevisions;

    const response = await applySyncMutations(
      sql,
      owner.id,
      [salaryEdit(2061, 10_000_600)],
      othersRevisions,
    );
    const ownPlanIds = (
      await sql<
        { id: string }[]
      >`SELECT id FROM plans WHERE user_id = ${owner.id}`
    ).map(({ id }) => id);

    expect(years(response.plans)).toEqual([2061, 2062]);
    expect(response.plans.every(({ id }) => ownPlanIds.includes(id))).toBe(
      true,
    );
    expect(response.unchangedYears).toEqual([]);
  });

  it("moves a year's revision exactly when its stored plan changes", async () => {
    const user = await accountWithYears("revision", [2061]);
    const before = (await listPlanSnapshot(sql, user.id)).planRevisions;

    await applySyncMutations(sql, user.id, [salaryEdit(2061, 10_000_700)]);
    const after = (await listPlanSnapshot(sql, user.id)).planRevisions;

    expect(after[0].revision).not.toBe(before[0].revision);
    expect((await listPlanSnapshot(sql, user.id)).planRevisions).toEqual(after);
  });
});
