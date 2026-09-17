# 09 — Operations

Running SaaKuu in production: what to back up, how to restore, what the worker does on its own, and where to
look when something goes wrong. Added in Phase 9.

## 1. What holds state

| Store | Holds | Back up? |
|---|---|---|
| PostgreSQL | Everything a person made: accounts, books, templates, documents, raw values, rows, cells, edits | **Yes, nightly** |
| Object storage (S3/MinIO) | Photo originals, rendered working copies and thumbnails | **Yes**, versioning or a mirror |
| Redis | Job queues, rate-limit counters, last-rebuild summaries | No: rebuilt on its own (§4) |

The database and storage must be restorable to roughly the same moment. The database is the source of truth: a
photo row points at storage keys, never the other way round.

## 2. Backups

**Database.** A nightly custom-format dump, kept for **no longer than `PHOTO_DELETE_GRACE_DAYS`** (default 30):

```sh
pg_dump "$DATABASE_URL" -Fc -f "saakuu-$(date -u +%Y%m%dT%H%MZ).dump"
```

A managed Postgres with point-in-time recovery is equivalent; keep its retention within the same limit.

**Object storage.** Either turn on bucket versioning with a lifecycle rule that expires non-current versions after
the grace period, or mirror the bucket nightly:

```sh
mc mirror --overwrite --remove=false prod/saakuu backup/saakuu
```

`--remove=false` matters: the mirror must keep objects the storage cleanup has deleted, until the backups that
reference them have aged out.

**Why retention ≤ grace period.** Deleted photos keep their files for `PHOTO_DELETE_GRACE_DAYS` before cleanup
removes them (§5). A database restored from a backup no older than that still finds every image it references. An
older backup restores rows whose images may be gone: the table and exports still work, but those photos won't show.

## 3. Restore

1. Stop the app and the worker, so nothing writes during the restore.
2. Restore the database into an empty database (or `--clean` into the existing one):
   ```sh
   createdb saakuu_restored
   pg_restore --no-owner --exit-on-error -d saakuu_restored saakuu-20260917T0200Z.dump
   ```
   Point `DATABASE_URL` at it. Run `pnpm db:deploy`: it applies nothing if the dump is current, and brings an older
   dump up to the deployed schema.
3. Restore storage if it was lost: mirror the backup back, or restore the bucket's versions to the same time.
4. Redis needs nothing. An empty Redis is fine.
5. Start the worker, then the app.
6. Check:
   - `curl <app>/api/health` reports `database`, `redis` and `storage` all `ok`.
   - `curl -X POST <app>/api/health/queue` completes a no-op job through the worker.
   - Sign in, open a book: the row count matches what you expect; open a document: its photo loads.

Rehearsed on 2026-09-17 against the dev stack: a `pg_dump -Fc` restored with `pg_restore --no-owner` into a fresh
database had identical counts for books, documents, photos, cells, cell edits and migrations.

## 4. Recovering in-flight work after a restore or crash

Nothing in Redis needs to survive. Lost jobs are found again from the database:

- **Extraction runs still `QUEUED`** are re-enqueued by the extraction status poll after a minute (docs/04,
  Extraction) whenever someone has the Documents tab or a drawer open.
- **Extraction runs left `RUNNING`** by a worker that died are put back in the queue by the **stale-run reaper**
  within about three minutes, or failed with "The worker stopped while reading these pages. Retry them." after
  being put back three times (docs/03 §7, As built, Phase 9).
- **Photos still `QUEUED`** are re-enqueued by the upload status poll; photos stuck `PROCESSING` for 10 minutes
  are re-ingested by the reaper, at most three times, then failed ("it stopped the worker more than once"), so a file
  that runs the worker out of memory can't crash-loop it.
- **Row rebuilds** that were queued are lost with Redis; press **Rebuild rows** on the template's Mapping tab.
  Rebuilds are free (no AI) and never overwrite edited cells.

## 5. Scheduled jobs

The worker registers these on the `system` queue at start (BullMQ job schedulers, one schedule however many workers
run):

| Job | When | Does |
|---|---|---|
| `system.reap-stale` | every 60 s | §4: stale `RUNNING` runs, stuck photos, documents whose run state drifted |
| `storage.cleanup` | daily 03:30 UTC | purge → due deletions → orphan sweep, below |

**Storage cleanup** (lib/storage/lifecycle.ts). No other code deletes stored files. One rule holds throughout: **an
object any Photo row references is never deleted.**

1. *Purge*: photos of documents or books deleted more than `PHOTO_DELETE_GRACE_DAYS` ago lose their photo rows and
   get a `StorageDeletion` tombstone, due at once. Rows, raw values and runs stay.
2. *Due deletions*: each tombstone past its `deleteAfter` has its files removed (the original, and everything under
   `books/{bookId}/photos/{photoId}/`), then the tombstone. Deleting a single page tombstones its files with
   `deleteAfter = now + grace`.
3. *Orphan sweep*: objects older than a day that nothing references are removed: presigned uploads that were never
   completed, PDF pages and source PDFs whose photos are gone, working copies and thumbnails for a transform that is
   no longer current, and files of photos that vanished without a tombstone. A source PDF is kept while any of its
   pages is a photo. Keys the sweep doesn't recognise are kept.

Run it by hand, and always dry-run first on a copy of real data:

```sh
pnpm storage:cleanup --dry-run
pnpm storage:cleanup
```

## 6. Rate limits

Fixed windows in Redis (lib/rate-limit.ts). A limited request gets `429 RATE_LIMITED` with `Retry-After`. If Redis
is unreachable the checks are skipped (logged as `rate limit check skipped`) rather than locking people out.

| Endpoint | Limit |
|---|---|
| `POST /api/auth/register` | 5 per email per hour · 60 per address per hour |
| `POST /api/auth/resend-verification`, `/forgot` | 3 per email per 15 min · 30 per address per hour |
| `POST /api/auth/verify`, `/reset` | 60 per address per 15 min |
| Password sign-in (failures only) | 10 per email from one address · 50 per email from anywhere · 100 per address, all per 15 min |
| `POST /api/extractions/start`, `/retry` | 20 per user per minute |
| `POST /api/extractions/estimate` | 120 per user per minute |

Wrong passwords typed for someone else's email lock that email out only at the typist's own address (10); the
per-email ceiling (50) takes guessing from many addresses.

**Client address.** `X-Forwarded-For` is a list each proxy appends to; its leftmost entries are whatever the client
sent. The app takes the entry `TRUSTED_PROXY_HOPS` (default 1) from the right: the address the outermost trusted proxy
saw. Set it to the number of proxies that append to the header (e.g. 2 for a CDN in front of a load balancer).
**Run the app behind a proxy**: a client that reaches Next.js directly can send its own header and choose its address.
Outside production, loopback addresses skip the per-address limits so local and E2E runs don't share one allowance.
`RATE_LIMIT_ENABLED=false` turns limits off, for local debugging only.

## 7. Logs

Both processes write one JSON object per line to stdout/stderr (`lib/log.ts`). Stack traces appear only here.

| Field | Meaning |
|---|---|
| `ts`, `level`, `msg` | always present |
| `requestId` | the API request (also returned as the `X-Request-Id` response header; a well-formed incoming one is kept) |
| `jobId`, `queue`, `jobName` | the worker job |
| `correlationId` | on job lines: the `requestId` of the request that queued the job |

To follow one extraction from click to finish, take `X-Request-Id` from the browser's network tab and search both
logs for it: the request line has it as `requestId`, the worker's lines as `correlationId`. Error pages show a
**Reference** (Next.js digest) that matches the server's error line.
