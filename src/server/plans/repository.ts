import "server-only";

import type { Sql, TransactionSql } from "postgres";
import type { BenefitEntry, ConfiguredAmount } from "../../domain/benefits";
import {
  type BudgetCategory,
  guidanceBucket,
  type CategoryColorToken,
  type ExpenseEntry,
  type PlanInput,
  type TransactionEntry,
} from "../../domain/budget";
import { DEFAULT_BENEFITS, DEFAULT_EXPENSES } from "../../domain/defaults";
import {
  stateCodeSchema,
  taxTreatmentSchema,
  type PlanBasics,
} from "../../domain/plan-schema";
import type { PlanRevision } from "../../domain/api-contracts";
import type { StoredPlan } from "../../domain/stored-plan";
import { canonicalJson } from "../../domain/sync";
import { parseFieldVersions } from "../field-versions";
import { isUniqueConstraintViolation } from "../postgres-errors";

export class PlanYearConflictError extends Error {}
export class SourcePlanNotFoundError extends Error {}
export class SourcePlanChangedError extends Error {}

interface PlanRow {
  id: string;
  year: number;
  state_code: string;
  filing_status: PlanInput["filingStatus"];
  gross_salary_cents: string;
  additional_income_cents: string;
  spouse_wage_income_cents: string;
  other_ordinary_income_cents: string;
  hsa_coverage: PlanInput["hsaCoverage"];
  primary_hsa_eligible: boolean;
  spouse_hsa_eligible: boolean;
  primary_hsa_catch_up_eligible: boolean;
  spouse_hsa_catch_up_eligible: boolean;
  primary_hsa_family_allocation_ppm: number;
  spouse_hsa_family_allocation_ppm: number;
  starting_savings_cents: string | null;
  updated_at: Date;
  field_versions: unknown;
}

interface BenefitRow {
  id: string;
  owner: "primary" | "spouse";
  type: BenefitEntry["type"];
  label: string;
  amount_kind: ConfiguredAmount["kind"];
  amount_value: string;
  discount_rate_ppm: number | null;
  custom_tax_treatment: unknown;
}

interface ExpenseRow {
  id: string;
  name: string;
  category_group: string;
  cadence: ExpenseEntry["cadence"];
  amount_cents: string;
  sort_order: number;
  guidance_bucket: "needs" | "wants" | "saving";
  color_token: CategoryColorToken;
  archived: boolean;
}

interface TransactionRow {
  id: string;
  category_id: string;
  amount_cents: string;
  title: string;
  note: string | null;
  transaction_date: string | Date;
  created_at: Date;
  updated_at: Date;
}

interface PlanBenefitRow extends BenefitRow {
  plan_id: string;
}

interface PlanExpenseRow extends ExpenseRow {
  plan_id: string;
}

interface PlanTransactionRow extends TransactionRow {
  plan_id: string;
}

type PersistableBenefit = Omit<BenefitEntry, "id"> & { id?: string };
type PersistableExpense = Omit<ExpenseEntry, "id"> & { id?: string };

function groupByPlan<T extends { plan_id: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.plan_id);
    if (group) group.push(row);
    else grouped.set(row.plan_id, [row]);
  }
  return grouped;
}

async function insertBenefits(
  transaction: TransactionSql,
  planId: string,
  entries: readonly PersistableBenefit[],
): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((entry, sortOrder) => ({
    id: entry.id ?? null,
    owner: entry.owner ?? "primary",
    type: entry.type,
    label: entry.label,
    amount_kind: entry.amount.kind,
    amount_value:
      entry.amount.kind === "percent"
        ? entry.amount.ratePpm
        : entry.amount.cents,
    discount_rate_ppm: entry.discountRatePpm ?? null,
    custom_tax_treatment: entry.customTaxTreatment ?? null,
    sort_order: sortOrder,
  }));
  await transaction`
    INSERT INTO benefits (
      id, plan_id, owner, type, label, amount_kind, amount_value,
      discount_rate_ppm, custom_tax_treatment, sort_order
    )
    SELECT coalesce(entry.id, gen_random_uuid()), ${planId}, entry.owner,
           entry.type, entry.label, entry.amount_kind, entry.amount_value,
           entry.discount_rate_ppm, entry.custom_tax_treatment, entry.sort_order
    FROM jsonb_to_recordset(${transaction.typed(JSON.stringify(rows), 25)}::jsonb) AS entry(
      id uuid, owner text, type text, label text, amount_kind text,
      amount_value bigint, discount_rate_ppm integer,
      custom_tax_treatment jsonb, sort_order integer
    )
  `;
}

async function insertExpenses(
  transaction: TransactionSql,
  planId: string,
  entries: readonly PersistableExpense[],
): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((entry) => ({
    id: entry.id ?? null,
    name: entry.name,
    category_group: entry.group,
    cadence: entry.cadence,
    amount_cents: entry.amountCents,
    sort_order: entry.sortOrder,
    guidance_bucket: guidanceBucket(entry),
    color_token: entry.colorToken ?? "blue",
    archived: entry.archived ?? false,
  }));
  await transaction`
    INSERT INTO expenses (
      id, plan_id, name, category_group, cadence, amount_cents, sort_order,
      guidance_bucket, color_token, archived
    )
    SELECT coalesce(entry.id, gen_random_uuid()), ${planId}, entry.name,
           entry.category_group, entry.cadence, entry.amount_cents,
           entry.sort_order, entry.guidance_bucket, entry.color_token,
           entry.archived
    FROM jsonb_to_recordset(${transaction.typed(JSON.stringify(rows), 25)}::jsonb) AS entry(
      id uuid, name text, category_group text, cadence text,
      amount_cents bigint, sort_order integer, guidance_bucket text,
      color_token text, archived boolean
    )
  `;
}

function configuredAmount(row: BenefitRow): ConfiguredAmount {
  const value = Number(row.amount_value);
  switch (row.amount_kind) {
    case "percent":
      return { kind: "percent", ratePpm: value };
    case "fixedAnnual":
      return { kind: "fixedAnnual", cents: value };
    case "fixedMonthly":
      return { kind: "fixedMonthly", cents: value };
  }
}

function mapBenefit(row: BenefitRow): BenefitEntry {
  const customTaxTreatment =
    row.custom_tax_treatment === null
      ? null
      : taxTreatmentSchema.parse(
          typeof row.custom_tax_treatment === "string"
            ? JSON.parse(row.custom_tax_treatment)
            : row.custom_tax_treatment,
        );
  return {
    id: row.id,
    owner: row.owner,
    type: row.type,
    label: row.label,
    amount: configuredAmount(row),
    ...(row.discount_rate_ppm === null
      ? {}
      : { discountRatePpm: row.discount_rate_ppm }),
    ...(customTaxTreatment === null ? {} : { customTaxTreatment }),
  };
}

function mapExpense(row: ExpenseRow): BudgetCategory {
  return {
    id: row.id,
    name: row.name,
    group: row.category_group,
    cadence: row.cadence,
    amountCents: Number(row.amount_cents),
    sortOrder: row.sort_order,
    guidanceBucket: row.guidance_bucket,
    colorToken: row.color_token,
    archived: row.archived,
  };
}

function mapTransaction(row: TransactionRow): TransactionEntry {
  const date =
    row.transaction_date instanceof Date
      ? row.transaction_date.toISOString().slice(0, 10)
      : row.transaction_date;
  return {
    id: row.id,
    categoryId: row.category_id,
    amountCents: Number(row.amount_cents),
    title: row.title,
    ...(row.note === null ? {} : { note: row.note }),
    date,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function materializePlan(
  row: PlanRow,
  benefits: readonly BenefitRow[],
  expenses: readonly ExpenseRow[],
  transactions: readonly TransactionRow[],
): StoredPlan {
  return {
    id: row.id,
    year: row.year,
    stateCode: stateCodeSchema.parse(row.state_code),
    filingStatus: row.filing_status,
    grossSalaryCents: Number(row.gross_salary_cents),
    additionalWageIncomeCents: Number(row.additional_income_cents),
    spouseWageIncomeCents: Number(row.spouse_wage_income_cents),
    otherOrdinaryIncomeCents: Number(row.other_ordinary_income_cents),
    hsaCoverage: row.hsa_coverage,
    primaryHsaEligible: row.primary_hsa_eligible,
    spouseHsaEligible: row.spouse_hsa_eligible,
    primaryHsaCatchUpEligible: row.primary_hsa_catch_up_eligible,
    spouseHsaCatchUpEligible: row.spouse_hsa_catch_up_eligible,
    primaryHsaFamilyAllocationPpm: row.primary_hsa_family_allocation_ppm,
    spouseHsaFamilyAllocationPpm: row.spouse_hsa_family_allocation_ppm,
    benefits: benefits.map(mapBenefit),
    expenses: expenses.map(mapExpense),
    transactions: transactions.map(mapTransaction),
    ...(row.starting_savings_cents === null
      ? {}
      : { startingSavingsCents: Number(row.starting_savings_cents) }),
    updatedAt: row.updated_at.toISOString(),
    fieldVersions: parseFieldVersions(row.field_versions),
  };
}

async function hydratePlan(
  sql: Sql | TransactionSql,
  row: PlanRow,
): Promise<StoredPlan> {
  const [benefits, expenses, transactions] = await Promise.all([
    sql<BenefitRow[]>`
      SELECT id, owner, type, label, amount_kind, amount_value, discount_rate_ppm,
             custom_tax_treatment
      FROM benefits
      WHERE plan_id = ${row.id}
      ORDER BY sort_order, id
    `,
    sql<ExpenseRow[]>`
      SELECT id, name, category_group, cadence, amount_cents, sort_order,
             guidance_bucket, color_token, archived
      FROM expenses
      WHERE plan_id = ${row.id}
      ORDER BY sort_order, id
    `,
    sql<TransactionRow[]>`
      SELECT id, category_id, amount_cents, title, note, transaction_date,
             created_at, updated_at
      FROM transactions
      WHERE plan_id = ${row.id}
      ORDER BY transaction_date DESC, created_at DESC, id
    `,
  ]);
  return materializePlan(row, benefits, expenses, transactions);
}

async function hydratePlans(
  sql: TransactionSql,
  rows: readonly PlanRow[],
): Promise<StoredPlan[]> {
  if (rows.length === 0) return [];
  const planIds = rows.map(({ id }) => id);
  const [benefits, expenses, transactions] = await Promise.all([
    sql<PlanBenefitRow[]>`
      SELECT plan_id, id, owner, type, label, amount_kind, amount_value,
             discount_rate_ppm, custom_tax_treatment
      FROM benefits
      WHERE plan_id = ANY(${planIds})
      ORDER BY plan_id, sort_order, id
    `,
    sql<PlanExpenseRow[]>`
      SELECT plan_id, id, name, category_group, cadence, amount_cents,
             sort_order, guidance_bucket, color_token, archived
      FROM expenses
      WHERE plan_id = ANY(${planIds})
      ORDER BY plan_id, sort_order, id
    `,
    sql<PlanTransactionRow[]>`
      SELECT plan_id, id, category_id, amount_cents, title, note,
             transaction_date, created_at, updated_at
      FROM transactions
      WHERE plan_id = ANY(${planIds})
      ORDER BY plan_id, transaction_date DESC, created_at DESC, id
    `,
  ]);
  const benefitsByPlan = groupByPlan(benefits);
  const expensesByPlan = groupByPlan(expenses);
  const transactionsByPlan = groupByPlan(transactions);
  return rows.map((row) =>
    materializePlan(
      row,
      benefitsByPlan.get(row.id) ?? [],
      expensesByPlan.get(row.id) ?? [],
      transactionsByPlan.get(row.id) ?? [],
    ),
  );
}

export async function getPlanByYearInTransaction(
  sql: TransactionSql,
  userId: string,
  year: number,
): Promise<StoredPlan | null> {
  const rows = await sql<PlanRow[]>`
    SELECT id, year, state_code, filing_status, gross_salary_cents,
           additional_income_cents, spouse_wage_income_cents,
           other_ordinary_income_cents, hsa_coverage, primary_hsa_eligible,
           spouse_hsa_eligible, primary_hsa_catch_up_eligible,
           spouse_hsa_catch_up_eligible, primary_hsa_family_allocation_ppm,
           spouse_hsa_family_allocation_ppm, starting_savings_cents, updated_at,
           field_versions
    FROM plans
    WHERE user_id = ${userId} AND year = ${year}
  `;
  return rows[0] ? hydratePlan(sql, rows[0]) : null;
}

export async function getPlanByYear(
  sql: Sql,
  userId: string,
  year: number,
): Promise<StoredPlan | null> {
  return sql.begin("isolation level repeatable read read only", (transaction) =>
    getPlanByYearInTransaction(transaction, userId, year),
  );
}

export interface PlanSnapshot {
  plans: StoredPlan[];
  planRevisions: PlanRevision[];
  /** Years omitted because the caller already holds that exact revision. */
  unchangedYears: number[];
}

export interface PlanDelta {
  known: readonly PlanRevision[];
  /** Years the caller just wrote to; they are always returned. */
  touchedYears: ReadonlySet<number>;
}

/**
 * Every plan year of the account, or — given what the caller already holds —
 * only the years it cannot reuse. Known revisions only ever narrow what is
 * returned from this account's own rows; a known year the account does not
 * have makes the answer complete again.
 */
export async function listPlanSnapshot(
  sql: Sql,
  userId: string,
  delta?: PlanDelta,
): Promise<PlanSnapshot> {
  return sql.begin(
    "isolation level repeatable read read only",
    async (transaction) => {
      const rows = await transaction<(PlanRow & { revision: string })[]>`
        SELECT id, year, state_code, filing_status, gross_salary_cents,
               additional_income_cents, spouse_wage_income_cents,
               other_ordinary_income_cents, hsa_coverage, primary_hsa_eligible,
               spouse_hsa_eligible, primary_hsa_catch_up_eligible,
               spouse_hsa_catch_up_eligible, primary_hsa_family_allocation_ppm,
               spouse_hsa_family_allocation_ppm, starting_savings_cents,
               updated_at, field_versions,
               xmin::text || ':' ||
                 (extract(epoch FROM updated_at) * 1000000)::bigint AS revision
        FROM plans
        WHERE user_id = ${userId}
        ORDER BY year
      `;
      const known = new Map(
        (delta?.known ?? []).map(({ year, revision }) => [year, revision]),
      );
      const years = new Set(rows.map(({ year }) => year));
      const reusable =
        delta && [...known.keys()].every((year) => years.has(year))
          ? new Set(
              rows
                .filter(
                  ({ year, revision }) =>
                    !delta.touchedYears.has(year) &&
                    known.get(year) === revision,
                )
                .map(({ year }) => year),
            )
          : new Set<number>();
      return {
        plans: await hydratePlans(
          transaction,
          rows.filter(({ year }) => !reusable.has(year)),
        ),
        planRevisions: rows.map(({ year, revision }) => ({ year, revision })),
        unchangedYears: [...reusable],
      };
    },
  );
}

export async function listPlans(
  sql: Sql,
  userId: string,
): Promise<StoredPlan[]> {
  return (await listPlanSnapshot(sql, userId)).plans;
}

export async function createPlanWithDefaults(
  sql: Sql,
  userId: string,
  basics: PlanBasics,
): Promise<StoredPlan> {
  try {
    return await sql.begin(async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
      INSERT INTO plans (
        user_id, year, state_code, filing_status, gross_salary_cents,
        additional_income_cents, spouse_wage_income_cents,
        other_ordinary_income_cents, hsa_coverage, primary_hsa_eligible,
        spouse_hsa_eligible, primary_hsa_catch_up_eligible,
        spouse_hsa_catch_up_eligible, primary_hsa_family_allocation_ppm,
        spouse_hsa_family_allocation_ppm
      ) VALUES (
        ${userId}, ${basics.year}, ${basics.stateCode}, ${basics.filingStatus},
        ${basics.grossSalaryCents}, ${basics.additionalWageIncomeCents},
        ${basics.spouseWageIncomeCents}, ${basics.otherOrdinaryIncomeCents},
        ${basics.hsaCoverage}, ${basics.primaryHsaEligible},
        ${basics.spouseHsaEligible}, ${basics.primaryHsaCatchUpEligible},
        ${basics.spouseHsaCatchUpEligible}, ${basics.primaryHsaFamilyAllocationPpm},
        ${basics.spouseHsaFamilyAllocationPpm}
      )
      RETURNING id
    `;
      const planId = rows[0].id;
      await Promise.all([
        insertBenefits(transaction, planId, DEFAULT_BENEFITS),
        insertExpenses(transaction, planId, DEFAULT_EXPENSES),
      ]);
      const created = await getPlanByYearInTransaction(
        transaction,
        userId,
        basics.year,
      );
      if (!created) throw new Error("Created plan could not be loaded");
      return created;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) throw new PlanYearConflictError();
    throw error;
  }
}

export async function copyPlanToYear(
  sql: Sql,
  userId: string,
  sourceYear: number,
  targetYear: number,
  expectedSourceUpdatedAt: string,
  expectedSourceFieldVersions: StoredPlan["fieldVersions"],
): Promise<StoredPlan> {
  try {
    return await sql.begin(async (transaction) => {
      const sourceRows = await transaction<PlanRow[]>`
      SELECT id, year, state_code, filing_status, gross_salary_cents,
             additional_income_cents, spouse_wage_income_cents,
             other_ordinary_income_cents, hsa_coverage, primary_hsa_eligible,
             spouse_hsa_eligible, primary_hsa_catch_up_eligible,
             spouse_hsa_catch_up_eligible, primary_hsa_family_allocation_ppm,
             spouse_hsa_family_allocation_ppm, starting_savings_cents, updated_at,
             field_versions
      FROM plans
      WHERE user_id = ${userId} AND year = ${sourceYear}
      FOR UPDATE
    `;
      const source = sourceRows[0];
      if (!source) throw new SourcePlanNotFoundError();
      const sourceFieldVersions = parseFieldVersions(source.field_versions);
      if (
        source.updated_at.toISOString() !== expectedSourceUpdatedAt ||
        canonicalJson(sourceFieldVersions) !==
          canonicalJson(expectedSourceFieldVersions)
      )
        throw new SourcePlanChangedError();
      const inserted = await transaction<{ id: string }[]>`
      INSERT INTO plans (
        user_id, year, state_code, filing_status, gross_salary_cents,
        additional_income_cents, spouse_wage_income_cents,
        other_ordinary_income_cents, hsa_coverage, primary_hsa_eligible,
        spouse_hsa_eligible, primary_hsa_catch_up_eligible,
        spouse_hsa_catch_up_eligible, primary_hsa_family_allocation_ppm,
        spouse_hsa_family_allocation_ppm, starting_savings_cents, field_versions
      )
      VALUES (
        ${userId}, ${targetYear}, ${source.state_code}, ${source.filing_status},
        ${source.gross_salary_cents}, ${source.additional_income_cents},
        ${source.spouse_wage_income_cents}, ${source.other_ordinary_income_cents},
        ${source.hsa_coverage}, ${source.primary_hsa_eligible},
        ${source.spouse_hsa_eligible},
        ${source.primary_hsa_catch_up_eligible},
        ${source.spouse_hsa_catch_up_eligible},
        ${source.primary_hsa_family_allocation_ppm},
        ${source.spouse_hsa_family_allocation_ppm},
        ${source.starting_savings_cents}, '{}'::jsonb
      )
      RETURNING id
    `;
      const targetId = inserted[0]?.id;
      if (!targetId) throw new Error("Copied plan ID was not returned");
      await transaction`
      INSERT INTO benefits (
        plan_id, owner, type, label, amount_kind, amount_value, discount_rate_ppm,
        custom_tax_treatment, sort_order
      )
      SELECT ${targetId}, owner, type, label, amount_kind, amount_value, discount_rate_ppm,
             custom_tax_treatment, sort_order
      FROM benefits
      WHERE plan_id = ${source.id}
    `;
      await transaction`
      INSERT INTO expenses (
        plan_id, name, category_group, cadence, amount_cents, sort_order,
        guidance_bucket, color_token, archived
      )
      SELECT ${targetId}, name, category_group, cadence, amount_cents, sort_order,
             guidance_bucket, color_token, archived
      FROM expenses
      WHERE plan_id = ${source.id}
    `;
      const copied = await getPlanByYearInTransaction(
        transaction,
        userId,
        targetYear,
      );
      if (!copied) throw new Error("Copied plan could not be loaded");
      return copied;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) throw new PlanYearConflictError();
    throw error;
  }
}

export async function exportAccount(sql: Sql, userId: string, email: string) {
  return {
    format: "kyle-financial-export",
    version: 2,
    exportedAt: new Date().toISOString(),
    account: { email },
    plans: await listPlans(sql, userId),
  } as const;
}
