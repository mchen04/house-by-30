# Quality evidence policy

Last reviewed: 2026-08-23

This directory contains maintained QA conclusions, not test-run storage.

Tracked documents should explain the tested behavior, method, important
findings, explicit misses, and residual risk. Raw screenshots, browser capture
JSON, generated measurement tables, judge transcripts, and per-cycle ledgers
are reproducible run artifacts and stay in temporary or ignored paths.

The distinction is deliberate:

- source code and tests are the executable truth;
- curated summaries preserve decisions and known limitations;
- raw output belongs to the run that produced it and is regenerated when
  current evidence is needed.

Current summaries:

- `browser-ux.md` — browser behavior and offline/sync checks;
- `daily-cockpit-baseline.md` — pre-cockpit UI baseline;
- `daily-cockpit-performance.md` — recorded interaction and database budgets;
- `logic-hardening.md` — deterministic tax, sync, and planner convergence;
- `mobile-density-baseline.md` — pre-density measurement and verifier limits;
- `mobile-density-convergence.md` — maintained outcome of the density work;
- `pwa-launch-performance.md` — launch, update, privacy, and test-audit results;
- `ui-quality.md` — earlier visual/responsive/trust convergence.

Research fixtures under `docs/research/evidence/` are different: tests consume
their exact values, so they remain tracked.
