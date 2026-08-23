# Verification strategy

Last reviewed: 2026-08-23

## Automated layers

- Domain unit/golden tests assert tax intermediates, explicit zero and threshold boundaries, exact-cent accounting, and display reconciliation.
- Fast-check properties cover wage/take-home and deduction/take-home monotonicity where mathematically valid, percent/fixed equivalence, sum invariants, and randomized plans.
- Schema tests prove 50 states plus DC, ordered brackets, valid rates, and citations.
- DAL integration tests apply migrations to a dedicated local PostgreSQL database, test atomic per-IP/per-identity authentication throttling, concurrent bucket reactivation versus bounded expiry cleanup, universal signup invitations, opaque signup and uniform login password verification, auth/session expiry, account isolation, CRUD, unique plan years, deep copy, and export.
- Offline tests use a fake IndexedDB environment to prove caching, idempotent replay, conflict ordering, and logout deletion.
- Component tests cover instant recomputation and accessible controls where browser E2E is not the stronger proof.
- Service-worker tests enforce public-cache ownership, private request exclusion, build matching, retained chunks, and safe cache retirement.
- `pnpm verify` runs format check, lint, typecheck, all tests, and production build.
- `pnpm test:coverage` records V8 statement, branch, function, and line coverage.

Tests never use the Neon connection. The test command requires a local URL whose database name ends in `_test`; the harness refuses any other database, creates a unique per-run schema, scopes every connection and migration to that schema, and removes it after the suite. Concurrent test processes therefore cannot reset or mutate one another's schema.

## Browser gate

Production browser passes cover 390x844, 430x932, 320x568, 844x390, 768x1024, and 1440x900, plus 200% text zoom. Required flows, activation budgets, keyboard order, accessibility scans, console/network checks, installability, offline cold relaunch, reconnect, and cache clearing run twice clean. Historical conclusions live in `docs/evidence/browser-ux.md`.

The PWA release gate also covers warm and cold launch, cached private paint, instant tabs, offline edit and reload, reconnect sync, safe update activation, reload recovery, account switching, logout, and cache ownership. `docs/evidence/pwa-launch-performance.md` records the current result.

## Performance and visual gates

Lighthouse runs against a production build with a realistic plan. Thresholds are Performance 90, Accessibility 95, Best Practices 95, LCP 2.5 seconds, and CLS 0.10. The UI quality loop judges captured surfaces at phone, small phone, and desktop until average 8.5+, every dimension 8+, and no blockers. Structural quality then converges for two independent clean passes.

## Evidence retention

Tests and scripts are the executable source of truth. Maintained evidence
documents record methods, important outcomes, explicit misses, and residual
risk. Raw screenshots, capture JSON, generated measurement tables, judge
transcripts, and loop ledgers are temporary run output and are not committed.
See `docs/evidence/README.md`.

## Current test audit

The audit started with 70 files and 652 tests. It ended with 73 files and 664 tests. Runtime changed from 22.14 seconds to 21.98 seconds.

Coverage changed from 80.22% to 80.54% for statements. Branches changed from 72.08% to 72.90%. Functions changed from 80.27% to 80.74%. Lines changed from 82.17% to 82.66%.

No useless or duplicate test had enough proof for deletion. The audit deleted zero tests. It kept failing, unique, boundary, and regression tests.

Two known-bad proofs failed as expected. Delayed private paint failed before the cache-first launch change. An API-cache mutation failed the service-worker privacy test. Both mutations were restored.

Physical Safari install and launch remain a release-device check. Local Chromium cannot prove that platform action.
