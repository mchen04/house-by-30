# PWA launch and update evidence

Status: maintained local result; rerun browser checks for a new release

Measured: 2026-08-23

The run used a production Chromium session and one isolated local test schema. It used disposable accounts only.

## Launch and navigation

| Measure                                             |       Before |      After |
| --------------------------------------------------- | -----------: | ---------: |
| Warm shell visible                                  |     10–12 ms |    10.1 ms |
| Warm cached private content                         |     54–58 ms |    43.6 ms |
| Cached private content with a 1.5 s bootstrap delay |     1,547 ms |    54.8 ms |
| Offline cached private content                      |      30.0 ms |    45.1 ms |
| Warm navigation response start                      |       4–5 ms | 1.4–2.0 ms |
| Warm navigation transfer                            | 10,114 bytes |    0 bytes |
| Primary tab change                                  |     31–49 ms |   31–49 ms |

The delayed launch is the main gain. Private paint no longer waits for the server.

The final worker returns the cached navigation shell first. Navigation preload and a background fetch refresh that shell.

The first Benefits chunk took 94.7 ms before idle preload. The final click made no request because Account, Benefits, and Compare loaded during idle time.

The final generated bundle has 16 JavaScript chunks and 1,223,934 uncompressed bytes. The largest chunk is 302,093 bytes. The installed launch read 1,093,342 decoded JavaScript bytes with zero transfer bytes.

## Update and privacy checks

A safe build change activated and reloaded without a click. Only the new shell cache remained.

A second build waited while a field held `123.`. Both build caches remained, and the input stayed unchanged.

Blur committed the field to IndexedDB. The worker then activated, reloaded, and removed the old cache.

The reloaded budget showed `$123`. This proves update activation waited for durability.

Account switching used a delayed bootstrap in both directions. The public shell showed, but neither account's private navigation or value appeared before server identity.

Logout removed only the current account database and its owner hint. It retained the public shell and the other disposable account database.

Cache inspection found no `/api/**` entry. Private JSON responses also returned `Cache-Control: private, no-store`.

Chrome reported no manifest or installability errors. The page had an active worker, the root scope, and one current shell cache.

## Offline edit and reconnect

The installed app launched offline and showed cached private content. A budget edit survived a second offline reload.

Reconnect sent one `/api/sync` request. The app returned to `Saved` with no duplicate request.

## Test audit

The baseline had 70 files and 652 tests. It ran in 22.14 seconds.

The final suite has 73 files and 664 tests. It ran in 21.98 seconds.

Coverage changed as follows.

| Metric     | Before |  After |
| ---------- | -----: | -----: |
| Statements | 80.22% | 80.54% |
| Branches   | 72.08% | 72.90% |
| Functions  | 80.27% | 80.74% |
| Lines      | 82.17% | 82.66% |

The audit found no useless or duplicate test with sufficient proof for deletion. No test was removed.

Two known-bad mutations proved the new checks can fail. Delayed private paint failed before the cache-first lifecycle change. Allowing an API URL into the worker cache failed the privacy test.

## Limits

These timings use local Chromium and a local server. They do not replace a physical iPhone launch check.

Chrome installability proves manifest and worker requirements. It does not simulate Safari's Add to Home Screen action.
