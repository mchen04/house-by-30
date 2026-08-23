# Architecture decision

Last reviewed: 2026-08-23

## Decision

House by 30 is one Next.js 16 App Router application on Node.js 20 with React 19 and TypeScript. Route handlers provide the JSON boundary, PostgreSQL is the server source of truth, and a small IndexedDB adapter provides the account-scoped offline cache and mutation outbox. The same dependency-free computation module runs in the browser and in Vitest.

Installed launch starts the public shell, IndexedDB read, and server bootstrap together. A matching cache can paint before the server responds. The server response then refreshes the same account in place.

The architecture follows the current Next.js guidance for a server-only data access layer: only `src/server/**` may import the database client or read secrets; every DAL operation accepts the authenticated account ID and includes it in its query. Route handlers validate input and output with Zod. Session cookies carry opaque random tokens; only a SHA-256 token digest is stored. Passwords use Node `crypto.pbkdf2` with SHA-256, a per-user salt, and a documented work factor, avoiding a native deployment dependency. Login and signup first consume an atomic PostgreSQL fixed-window counter for the Vercel-provided client IP before JSON parsing, then a normalized-email counter after schema validation and before PBKDF2. Counter keys are hashed at rest, concurrent function instances share the same limits, signup volume is bounded per IP, exhausted buckets return `429` with `Retry-After`, and a limiter failure fails closed. Buckets become cleanup-eligible five minutes beyond the longest live policy window, and opportunistic expiry locks and removes at most 100 rows per request while skipping a bucket that another request is reactivating.

Signup is public and always returns the same accepted response, preserving the
same boundary behavior for new and existing normalized identities. Shared
PostgreSQL rate limits permit at most ten signup attempts per IP and ten per
normalized email each hour before password hashing or insertion. Retries are
deliberately generous: a public signup that always returns the same accepted
response must let a real person recover from a typo without being locked out of
their own address. The browser
then signs in through the ordinary login boundary, which runs the same
600,000-iteration PBKDF2 verification path for missing and present identities
before returning its generic credential error.

Money is integer cents. Rates are integer millionths (1% = 10,000).
Multiplication uses `BigInt`, with half-away-from-zero rounding once at the
boundary where a percentage becomes money. Annual amounts are authoritative.
Daily budgeting uses a deterministic remainder allocation so the twelve
displayed month values sum to the annual cent; selected-month, YTD, and
full-year rollups share one pure period model.

## Why this stack

- Next.js keeps server-rendered account entry, private route handlers, shared types, and the installable client in one deployable.
- PostgreSQL is durable, supports ordered SQL migrations, and matches the supplied Neon target and local test server.
- Custom SQL, service worker, and IndexedDB modules keep schema ownership, authorization predicates, update behavior, and conflict rules visible.
- Vitest and fast-check cover deterministic math without coupling it to the UI.

Rejected alternatives:

- A client-only SPA would need a second authentication/data service and weakens offline/server-source-of-truth integration.
- A separate API server doubles deployment and maintenance for a one-person product.
- Prisma adds a generated client and migration abstraction that is not needed for this small, explicit schema.
- A PWA framework plugin obscures cache-version transitions; the required offline model is small enough to implement and test directly.
- `localStorage` is synchronous, too limited for an outbox, and does not meet the iOS durability requirement.

## Boundaries

```text
Browser UI ── plan draft ──> pure engine <── versioned JSON tax table
    │                              │
    ├── IndexedDB account cache    └── complete computed breakdown
    └── authenticated /api ──> server DAL ──> PostgreSQL
                 session cookie ──┘
```

- `src/domain/**`: pure values, tax tables, calculation, warnings; no React, I/O, clock, or environment access.
- `src/offline/**`: IndexedDB cache/outbox and deterministic last-write-wins reconciliation.
- `src/server/**`: server-only environment, database, authentication, and account-scoped DAL.
- `src/app/api/**`: HTTP parsing, Zod validation, status codes, and safe DTOs.
- `src/app/**` and `src/components/**`: product surfaces and instant local recomputation.
- `migrations/**`: ordered, idempotent-forward SQL. Tests apply from empty against local PostgreSQL only.

## Data and conflict model

One plan exists per `(user_id, year)`. Benefits and budget categories are owned
through a plan foreign key. The legacy `expenses` table is now the canonical
plan-year category store: every row has allocation/cadence,
Need/Want/Saving role, stable color, sort order, and archive state. It retained
its table name so the forward migration does not replace or reinterpret
existing allocations. Actual transactions are separate dated rows keyed to
both plan and category; a composite foreign key prevents a transaction from
crossing a plan boundary. Category copy-forward creates new identities and
copies structure, never transaction history. Renaming or archiving keeps
historical transaction references valid.

Scalar plan fields plus individual benefit, category, and transaction
properties carry an update timestamp and mutation ID in plan version metadata.
Each mutation also carries its server base version, distinguishing a fresh edit
on a slow clock from a stale offline edit. Browser edits use the same durable
outbox whether nominally online or offline. Future client clocks are clamped to
ordered receipt instants; equal instants break ties by mutation ID. Duplicate
IDs must carry identical canonical content, with a transaction advisory lock
making concurrent delivery idempotent. Mutation receipts remain for the
account lifetime because offline retries have no matching expiry; account
deletion removes them through the user foreign-key cascade. Bounded batches,
per-year freshness, and revision checks prevent oversized, cross-tab, or
in-flight responses from discarding newer local work.

Transaction dates are local `YYYY-MM-DD` values stored in PostgreSQL `date`;
the domain validates and compares their components without passing through UTC.
Starting savings is optional. The savings-impact function reports planned cash
savings, payroll saving, employer saving, saving-category funding, and spending
variance separately; actual variance and funding replace their planned
counterparts exactly once. An ending balance is derived only when starting
savings is configured.

The browser database name includes the authenticated user ID. Login also sets a readable cache-owner hint with the session UUID. This value is not an authentication token.

The client paints private cache data only when this hint matches the cached session. A mismatch keeps the public shell visible until bootstrap confirms the account. A missing legacy hint becomes trusted only after a successful bootstrap or a network failure for the remembered account.

Every private request binds the screen's expected account ID to the cookie-authenticated account. A mismatch returns 409 before access and broadcasts cross-tab eviction. Logout and deletion also bind the rendered server session UUID. A stale close cannot consume a newer same-account cookie.

Web Locks serialize private browser writes and account closure across tabs. A global shell lock protects remembered identity. An unsupported browser reports a persistence failure.

Logout and deletion refuse any undurable displayed draft. They write a mode-aware indeterminate closure marker before the server request. Startup and offline fallback honor that marker. Only explicit authentication clears it.

Account deletion calls the authenticated `DELETE /api/account` boundary after that durability and marker gate. The repository deletes the owned user row; foreign keys cascade through sessions, plans, benefits, expenses, and mutation receipts inside one database transaction. A definitive 409 account-mismatch rejection may roll back a newly created marker because the server proves that it did not act. Indeterminate outcomes instead return to authentication with an explicit verification/retry notice; signing in proves that the account still exists, clears the marker, and permits another deletion attempt. Closure modes are not interchangeable: a confirmed deletion also satisfies logout, but a logout marker can never claim that deletion succeeded.

## Tax table lifecycle

Tax tables are JSON data keyed by year. Federal filing-status schedules and all state entries include source IDs and approximation notes; the federal file also owns each ID's display label and URL, so citations render without a component registry. One jurisdiction tuple defines the exhaustive 50-state-plus-DC keys used by domain types, Zod boundaries, plan validation, and the state importer. A missing requested year selects the greatest available year not newer than the request, or the latest available table if all tables are newer, and returns `isFallback: true`. The generated TypeScript registry discovers complete `<year>.federal.json` / `<year>.states.json` pairs before development, tests, verification, and production builds. Adding a tax year therefore changes data and evidence only; neither the registry nor the engine is hand-edited.

## Deployment shape

The production target is a Node-capable Next.js host with a server-only `DATABASE_URL`. Neon is the production database. Static public assets and the service worker are served by the same origin. No background worker, email service, bank integration, or paid dependency is required.

Automatic Git deployments are disabled. A production release requires an explicit operator command after verification and migration review.

Each build has one stable deployment ID. The ID appears in the worker bytes, shell cache name, page prop, and response header.

The worker owns only the public shell, icons, manifest, and static chunks. IndexedDB owns private plans and the outbox. Every JSON API response is `private, no-store`.

Navigation uses a cached shell with background refresh. Worker install fetches the shell and its initial static chunks as one version. Old shell caches remain while any live page reports an old build.

## Generated and historical files

Two generated files are required at build/deploy time and therefore remain
tracked: `src/domain/tax/table-registry.generated.ts`, which makes discovered
tax-table pairs compiler-visible, and `public/sw-runtime.js`, which is emitted
from the typed service-worker source. The lockfile is also tracked dependency
state. `.gitattributes` marks all three as generated so GitHub collapses them
and excludes them from language statistics.

Raw browser captures and convergence ledgers are not architecture. The
executable gates live in `scripts/` and tests; `docs/evidence/` retains only
maintained conclusions and limitations.
