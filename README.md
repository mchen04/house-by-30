# House by 30

Offline-first daily money cockpit backed by an annual plan. House by 30 turns yearly income, estimated taxes, payroll benefits, and category allocations into a selected-period safe-to-spend answer; dated transactions update Home, Budget, Activity, Monthly Wrap, and projected savings immediately. Plans are private per account, persist in PostgreSQL, and remain editable offline through an account-scoped IndexedDB outbox.

## Local setup

Requirements: Node 20+, pnpm, and PostgreSQL.

```bash
pnpm install
export DATABASE_URL='<local-database-url>'
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000` and create an account with an email and a password.
Public registration is limited to ten attempts per IP and ten attempts per
normalized email each hour. Migrations must run before the application starts;
apply every ordered SQL file in
[`migrations/`](migrations/) through `pnpm db:migrate`. Never point automated
tests at production: `TEST_DATABASE_URL` defaults to the isolated local
`kyle_financial_test` database.

## Verification

```bash
pnpm verify
```

The gate runs formatting, token-authority checks, lint, TypeScript, deterministic unit/property/integration tests, and a production Next.js build. PostgreSQL tests create an isolated local test database and apply every migration from empty.

Use `pnpm test:coverage` for the maintained V8 coverage report. Coverage output is a run artifact and is not committed.

## Yearly tax-table update

1. Copy the prior year's `src/domain/tax/tables/<year>.federal.json` and `<year>.states.json` to the new year and replace every value, citation ID, and `sources` label/URL from the current IRS, SSA, and Tax Foundation sources.
2. Keep each JSON file's top-level `year` equal to its filename. No TypeScript registry edit is needed: `pnpm verify` discovers complete filename pairs, validates all 50 states plus DC and every citation destination, and regenerates the compiler-checked registry.
3. Update `docs/research/sources.md` and `docs/research/tax-validation.md`, including the five external gross-to-net comparisons.
4. Run `pnpm tax:longevity-drill` and `pnpm verify`, review the diff, commit the two data files plus maintained source/validation documentation, and redeploy. Raw command or browser output is not committed.

If a requested year is absent, the app selects the latest prior table and visibly labels the applied tax year. The drill creates a temporary next-year pair, proves exact selection plus later-year fallback, and removes it again.

## Account recovery and deletion

There is intentionally no email reset service. For a manual password reset, work from a trusted shell with a database backup: generate a replacement using `hashPassword` in `src/server/auth/crypto.ts`, update only the matching normalized `users.email` row's `password_hash`, and delete that user's `sessions` rows so every device must sign in again. Run both statements in one transaction and verify exactly one user row matched before commit. Never paste the password or database URL into shell history, logs, or source.

Users can permanently delete themselves from Account. The app first makes local edits durable, then deletes the user row and all owned sessions/plans through foreign-key cascades, clears IndexedDB, and broadcasts logout. For emergency operator deletion, export first if possible, then delete the single confirmed `users` row inside a transaction; do not truncate or reset the schema.

## Install on iPhone

Open the deployed HTTPS URL in Safari, tap Share, choose **Add to Home Screen**, and open House by 30 from the new icon. Safari has no install prompt, so the Account screen repeats these steps. Complete one online sign-in and sync before testing an offline launch. This step binds the account hint to its private IndexedDB cache. Later launches can show matching cached data before the server responds. Home, Fast Log, Activity, Budget, Wrap, and Plan then work without a network connection.

## Production and Vercel runbook

Provide the server-only `DATABASE_URL`, then run migrations before starting the new build:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

Provide one stable deployment ID per build. Vercel uses `VERCEL_GIT_COMMIT_SHA`. Other hosts can set `NEXT_DEPLOYMENT_ID` or `GIT_SHA`. The local Git SHA is the final fallback.

`vercel.json` enables automatic deployments from `main` only. Vercel connects
to `mchen04/house-by-30` with `main` as the production branch. Each merge
builds and releases the app at <https://kyle-financial.vercel.app>.
Run `pnpm verify` and review migrations before merging. Apply required
backward-compatible migrations before the merge; the deployment build does
not run migrations.

For Vercel, create or link the project, add `DATABASE_URL` as an encrypted
Production environment variable, and run `pnpm db:migrate` once from a trusted
local shell against the production database before the first deployment.
After merging, confirm the automatic deployment reaches `Ready` and the
production URL serves the merged commit's build ID. Check the live sign-in
form, manifest, and service-worker update without changing user data. Run
automated authentication and data tests only against an isolated local
database. `vercel deploy --prod` remains available for an explicit manual
release. Migrations are ordered and
idempotent; never reset the production schema during deployment. Roll back
application code by redeploying the prior known-good commit—do not roll back or
delete data migrations.

The service worker caches only the public app shell and build assets. It never stores `/api/**` or private plan JSON in Cache Storage. It checks for updates during normal use. It activates and reloads automatically after visible edits become durable. See [architecture](docs/architecture.md), [offline and sync behavior](docs/offline-and-sync.md), and [PWA research](docs/research/pwa-2026-08.md).

Signed-in users can export every plan year, category, and transaction as one server-backed JSON file from Account. A second account-scoped device export remains available offline for the data currently cached on that device. Ordinary logout revokes the session and clears the local private cache without deleting server plans.

If an update waits, finish or blur the current field and wait for `Saved`. If offline work does not sync, reopen the app online and use the visible retry action. Clear site data only when losing unsynced local work is acceptable. Site-data clearing does not delete server plans; sign in online to restore them.

## Repository anatomy

The repository is intentionally source-heavy, but it is not a 160k-line
application. A July 2026 audit found that 103k tracked lines were raw UI capture
JSON and another roughly 3k were generated tables and a per-wave convergence
diary. Those run artifacts have been removed, leaving about 65k tracked text
lines including the 8k-line lockfile.

- `src/` contains the application, domain, offline, server, and co-located test
  code (about 46k tracked lines at the audit).
- `scripts/` contains migration, tax-table, service-worker, and UI-verifier
  tooling (about 6.6k lines).
- `migrations/` is the required ordered PostgreSQL history.
- `docs/` contains maintained architecture, operations, research, and curated
  quality conclusions. It is not a storage location for raw test runs.
- `public/sw-runtime.js` and
  `src/domain/tax/table-registry.generated.ts` are reproducible but required
  deployment/compiler inputs. They stay tracked and are marked generated for
  GitHub.
- `pnpm-lock.yaml` is generated dependency state and stays tracked for
  reproducible installs.

Three authored files remain above 1,000 lines:
`scripts/measure-density.mjs`, `scripts/measure-alignment.mjs`, and
`src/server/sync/repository-merge.test.ts`. They are executable verifier/test
infrastructure rather than production bundle output. Their size is
maintainability debt and a candidate for later decomposition, not a reason to
delete or label them generated.

Build output (`.next/`, `out/`, TypeScript build metadata), local environment
files, screenshots, capture JSON, measurement tables, and loop ledgers are
ignored. The five unused Next.js starter SVGs and an unreferenced 1024px icon
were removed in the same audit.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system boundaries, data and
  conflict model, tax-table lifecycle, and deployment shape.
- [`docs/offline-and-sync.md`](docs/offline-and-sync.md) — browser cache,
  outbox, reconciliation, closure fencing, and worker updates.
- [`docs/surface-map.md`](docs/surface-map.md) — product surfaces, hierarchy,
  and responsive navigation.
- [`docs/test-strategy.md`](docs/test-strategy.md) — executable verification
  layers and evidence policy.
- [`docs/research/`](docs/research/) — dated tax, navigation, and mobile-density
  source research.
- [`docs/evidence/`](docs/evidence/) — curated historical QA conclusions; see
  its README for what is intentionally not tracked.
