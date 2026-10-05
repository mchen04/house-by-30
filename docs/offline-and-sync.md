# Offline cache and reconciliation

Last reviewed: 2026-08-23

The PostgreSQL server is the source of truth. IndexedDB is an account-scoped working cache so the installed PWA can open and edit without a network.

## Storage layout

- `kyle-financial-shell` stores only the last authenticated user ID/email and non-secret server session UUID. This record locates one offline account cache and fences destructive close requests. Legacy records without a session UUID remain readable. Their remote close outcome stays indeterminate. Logout removes the record but keeps the empty shell database.
- `kyle-financial-account-<user UUID>` stores complete plan DTOs keyed by year and an outbox keyed by mutation UUID. Another account uses a different database name. Logout deletes the current account database before another account can use the app.
- `kyle_cache_owner` is a readable session UUID cookie. The server sets it with the login session expiry. It is an account hint, not an authentication token.
- The service-worker cache contains the public app shell, manifest, icons, and same-origin static resources. It never caches `/api/**`, React Server Component requests, or private plan JSON.

The app requests persistent browser storage when supported. Installed iOS home-screen storage remains platform-controlled, so server persistence and JSON export are still the durability guarantees.

Account exposes two deliberately labeled export paths. **Export all years**
downloads the server source of truth when online. **Export this device** creates
an account-scoped JSON file entirely in the browser from the plans currently in
memory, so categories and transaction history already cached on that device
remain exportable offline. The local file identifies itself as a device-cache
source and never claims to include another device's unsynced work.

## Offline lifecycle

1. Launch starts the cached-account read and `/api/bootstrap` together.
2. A matching owner hint can paint private data before bootstrap finishes. A mismatch never paints cached private data.
3. A missing legacy hint waits for bootstrap. A network failure can restore the remembered account. A real HTTP 401 never restores private data.
4. A successful bootstrap confirms the account, refreshes its cache, and reconciles pending work. A 401 clears a matching owner hint.
5. Every edit immediately recomputes in memory and atomically commits the
   cached plan plus its outbox mutations in one IndexedDB transaction, even
   when the browser reports online. Network delivery is a separate debounced
   step, so a failed request cannot strand the edit in React memory. Scalars
   diff independently; existing benefits, categories, and transactions diff by
   property under a stable item UUID. A Fast Log transaction and an inline
   category creation therefore survive a cold offline relaunch before any
   network delivery.
6. On reconnect, the foreground `online` path compacts superseded edits. It drains valid work in chronological batches of at most 500. The app does not depend on Background Sync. An unresolved blank label stays pending as an explicit error but cannot block unrelated valid mutations. After acknowledgement, the client takes the server snapshot from the sync response. It caches that snapshot only when the outbox is empty and the server revision is current.
7. Duplicate posts are safe: `(user_id, mutation_id)` is the receipt key.
   Receipts remain until account deletion because an offline outbox mutation
   has no retry expiry; pruning one earlier would let a delayed duplicate act
   as a new mutation.
8. The server applies a batch to one in-memory copy of each plan year. It still validates the whole year before commit.

## Plan revisions

Bootstrap, `GET /api/plans`, and sync responses include `planRevisions`: one opaque string per year. The string changes whenever the stored year changes. The client keeps the server copies it has confirmed in memory, keyed by revision, and sends them as `knownPlanRevisions` with each sync.

The sync response then omits years that match a sent revision and lists them in `unchangedYears`. A year the batch wrote is always returned. A sent year the account does not have makes the response complete again. If the client no longer holds an omitted year, it discards its confirmed copies and fetches a complete snapshot. A local edit drops that year's confirmed copy. Logout and account change drop all of them.

Both fields are optional. An old client sends no revisions and gets every year. A new client reading an old server sees no `unchangedYears` and treats `plans` as complete. The IndexedDB format and outbox format are unchanged, so either build can be rolled back without a cache reset or migration.

## Conflict rule

Last-write-wins is applied independently to:

- state;
- filing status;
- gross salary;
- bonus/RSU wages;
- spouse wages;
- other non-wage taxable income;
- HSA coverage;
- each benefit UUID and its editable properties;
- each category UUID and its editable allocation/name/group/role/color/order/archive properties;
- each transaction UUID and its editable category/amount/title/note/date
  properties.

Each plan exposes the server `{updatedAt, mutationId}` version for every
scalar/item. Every local mutation records the version it was based on. A
matching base applies even when the client clock is slow; when the base is
stale, timestamp then mutation UUID resolves the true conflict, with future
clocks clamped to receipt time. Whole-item and property mutations consult the
same entity version, including tombstones, so an older property cannot corrupt
a newer replacement and an update to a deleted row is reported as not applied.
Disjoint item edits merge; edits to the same item resolve deterministically.
Duplicate transaction creation replays the same receipt and does not create a
second row.

Queued writes capture their plan-year baseline before asynchronous IndexedDB work begins and advance it only after persistence succeeds. Cache writes apply field mutations to the existing per-year record, so a stale tab cannot erase a disjoint cached edit with a full snapshot. Reconciliation refreshes every year’s baseline together and merges server freshness per year.

The in-memory plan list is also an intent ledger: every draft change updates it synchronously before IndexedDB work begins, and year navigation reads from that ledger. Completing an older device write never overwrites newer in-memory intent. This prevents a quick edit → switch year → switch back sequence from selecting an old server snapshot and manufacturing a revert, while an actual user revert remains a distinct serialized intent.

Account identity fences state changes. Every private browser request names the account the current screen expects; the server compares it with the authenticated cookie account and returns 409 before any read or write if another tab changed the shared session. Destructive close requests also name the server session UUID captured by the rendered tab. This second fence rejects a stale same-account close even when it acquires its Web Lock after another tab installs a newer cookie but before that tab's authentication broadcast is delivered. Authentication by a different account evicts stale rendered data; authentication by the same account updates the rendered session identity and cancels a queued or already-granted close before remote dispatch without discarding that account's pending edit chain. Browsers must support Web Locks to serialize private IndexedDB writes and account closure across tabs; a global shell lock also protects the shared remembered-user record. If Web Locks are absent, local persistence reports an explicit failure instead of pretending an unfenced lease is safe.

Logout and deletion refuse pending, rejected, volatile, or otherwise undurable displayed work. Under the account lock, the browser writes a mode-aware `indeterminate` closure marker before the remote request; a confirmed response advances it to `terminal`. A lost, timed-out, or aborted response cannot prove whether the server committed, so the browser keeps the protective marker, broadcasts eviction, clears or locks the private cache and remembered identity, and shows a verification/retry notice. A definitive 409 may remove only a newly created marker because it proves that the expected account was not changed. Explicit authentication clears either marker state and is the recovery path for an indeterminate deletion. A deletion marker may satisfy a later logout, but a logout marker never satisfies deletion. The revoked opaque cookie is left inert until expiry or the next login replaces it, because a delayed logout response must never clear a newer login cookie from another tab. Startup restoration and offline fallback honor every closure marker.

Every mutation envelope and supported payload is prevalidated independently at the server. Malformed entries are acknowledged as rejected and removed from delivery without rolling back valid peers in the same batch. Each plan-year group then runs in its own SQL transaction: the server locks the plan, applies only the mutations that win reconciliation, hydrates that actual prospective result through the same repository, and validates every aggregate and cross-field invariant before commit. An invalid year rolls back as a unit while valid years remain independent. The client keeps rejection or local IndexedDB failure visibly in `Save failed`; an empty outbox alone cannot turn a volatile failed edit into `Saved`.

Duplicate mutation IDs are accepted only when their canonical payload is identical; reusing an ID with different content rejects the transaction. This is deliberately not a collaborative document editor, but it does preserve independent category and benefit edits without whole-list data loss.

## Service-worker updates

`/sw.js` contains the current deployment ID. The same ID appears in the shell cache, page prop, and response header. The hosting SHA supplies the ID. A local Git SHA is the fallback.

Install fetches the root shell without HTTP cache reuse. It extracts and caches the initial static files. A build-header mismatch rejects the install.

Navigation returns the cached shell first. Navigation preload and a background request refresh it. The worker caches only approved public URLs. It rejects cross-origin, API, and React Server Component requests.

The client checks for updates at launch, reconnect, page restore, visibility return, and every hour. It uses `updateViaCache: none` for the worker script.

A waiting worker activates automatically only when the page is visible and has no buffered or undurable edit. A blocked update shows `Update ready · saving first`. The client retries after the edit becomes durable.

Activation claims clients. Each live page reports its build. The worker keeps old shell caches until every live page uses the current build. This protects lazy chunks in an old page. A reload guard prevents a controller-change loop.

## Recovery and operations

- If an update waits, finish or blur the current field. Keep the page visible until `Saved` appears.
- If offline work does not sync, reopen the app online. Wait for `Saved`, or use the visible retry action.
- Logout clears the current private IndexedDB cache and owner hint. It does not delete server plans.
- Clearing site data removes local-only unsynced work. It does not remove server data. Sign in online to restore the server copy.
- Never use browser cache clearing as database recovery.
- Roll back application code without rolling back migrations or deleting database history.
