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

On the production host this is `deploy/backup-db.sh`, run nightly from cron (the line is in the script's
header). It dumps from the `postgres` container and uploads to `BACKUP_S3_BUCKET`; retention is that bucket's
lifecycle rule, not the script. The host's `.env` is in no backup: keep a copy with the deployment's other
secrets, because a restored database is of no use without `AUTH_SECRET` and the storage keys.

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
| `storage.cleanup` | daily 03:30 UTC | purge → due deletions → orphan sweep, below; from Phase 12 it also strips `rawResponse` from old successful runs (§8) |

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

## 8. AI cost and keys (Phase 12, Phase 21)

Extraction is the only thing this product does that costs money per use, and until Phase 12 none of it
was visible: `ExtractionRun.inputTokens` and `outputTokens` had been recorded since Phase 5 and were
surfaced nowhere, there was no quota and no per-user cap, and a single server key meant every user's
extraction landed on the owner's bill.

**One key in use** (decision 79). Every reading runs on the deployment's `GEMINI_API_KEY`, so every
reading is on the owner's bill. Two things follow, and both are configuration:

- **`SIGNUP_ALLOWED_EMAILS` is the spend limit.** The invite list: comma-separated addresses, or `*`
  for anyone. There is no quota (below), so it is the only bound on what the key spends. It is asked
  in two places:
  - **creating an account**, by password or by a first Google sign-in;
  - **reading on the server's key** — extraction and `Propose fields`, resolved in the worker.

  Signing in is never gated. Taking someone off the list therefore stops their spending and nothing
  else: they keep their books, can review and can export, and the Extract dialog tells them reading
  isn't switched on for their account. The same goes for an account made before there was a list —
  **put your own address on it**.
  - Addresses match exactly after trimming and lowercasing. Gmail's dots and `+tags` are not folded:
    invite the address the person will actually sign up with.
  - Adding or removing someone is an edit and a restart of the app **and the worker**.
  - **Fails closed.** A value that is set but names nobody (a stray space, `,,`), or has an entry that
    isn't an address, stops the app at boot. In production, leaving it unset while `GEMINI_API_KEY` is
    set stops it too: open sign-up on a paid key has to be chosen, with `*`. Outside production,
    unset means anyone, which is what local work and the E2E suite use.
- **`ENCRYPTION_KEY` stays blank.** It is the switch for personal keys (decision 54), which are dormant:
  with it unset there is no key section on the account page, no dialog names a key, and operators see
  pages and time rather than money. Setting it brings all of that back for whoever saves a key.

**Before letting anyone in:**

1. `GEMINI_API_KEY` is on a **paid** tier. Operators' paper — often clinic registers — goes through this
   Google account, and unpaid-tier requests may be used to improve Google's models.
2. `SIGNUP_ALLOWED_EMAILS` lists the testers **and you**, and the sign-up page says `invite-only`.
3. `ENCRYPTION_KEY` is blank, and `/account` shows only `Reading so far`.
4. `EXTRACTION_RPM` and `EXTRACTION_CONCURRENCY` match the key's real limits. They are **queue-wide**:
   one operator's five-hundred-page batch is ahead of everyone else's single page.
5. The two spend queries below are run weekly. Their history is what sets a price and a quota.
6. Something watches the worker's log for `server AI key is missing or refused` at `error` level. When
   the key expires or loses access to a model, every operator is told only to try again later; that
   line is the one place it is said to you.

**Personal keys, where they are switched on** (decision 54). A user can save their own Gemini key and
it wins over the server's. `providerStatus()` resolves per user, and the dialogs name that key and
state the cost in money, because the run lands on that user's own bill.

- User keys are encrypted at rest (`lib/crypto`, `ENCRYPTION_KEY`). They are never logged, never
  returned to the client and never included in an error message. Only the last four characters are
  shown back.
- **Rotating `ENCRYPTION_KEY` invalidates every stored user key.** There is no re-wrap step in v1: if it
  is rotated, users must paste their keys again. Treat it like a database credential — back it up with
  the deployment secrets, separately from the database dump, or a restore comes back with keys that
  cannot be decrypted.
- A restored backup carries ciphertext. It is only usable with the `ENCRYPTION_KEY` that was live when
  the dump was taken.
- `ENCRYPTION_KEY` is 32 bytes, base64 or hex (`openssl rand -base64 32`), validated at boot. It is
  **optional**: without it the app runs, the account page has no key section, and everyone uses
  `GEMINI_API_KEY`. A key saved earlier is then simply not read. With it set, a key that cannot be
  decrypted fails that user's run with "save it again" and never falls back to the server key — that
  fallback would put their spending back on the owner's bill.
- A run uses the **book owner's** key however it was started, resolved from `Book.userId` in the worker.

### What the estimate is estimating

The Extract dialog's money figure comes from per-million-token list prices held in `lib/ai/models.ts`
(`inputPricePerMTok` / `outputPricePerMTok`), each with the date it was checked. **They are constants in
code, not configuration**: changing a price is a commit. Re-check them against the provider's price
sheet when the bill stops matching the readout, and update the date.

Output tokens are estimated from the book's **own** completed runs (average output tokens per page),
falling back to constants until a book has read something. That matters most on TABLE registers, where a
page holds however many rows the paper holds — a single constant is wrong by multiples in both
directions, and a money figure that is wrong by multiples is worse than showing tokens.

### Watch the bill

There is deliberately **no quota** (decision 55). Sizing a limit before hosted extraction is a real cost
line, and before per-document pricing is understood, prices the product blind. What to watch instead,
from the token columns already recorded:

```sql
-- spend shape for the last 30 days, per user
SELECT u.email,
       count(*)                      AS runs,
       sum(r."inputTokens")          AS in_tokens,
       sum(r."outputTokens")         AS out_tokens,
       count(DISTINCT r."documentId") AS documents
FROM "ExtractionRun" r
JOIN "Document" d ON d.id = r."documentId"
JOIN "Book"     b ON b.id = d."bookId"
JOIN "User"     u ON u.id = b."userId"
WHERE r."finishedAt" > now() - interval '30 days'
  AND r.state = 'COMPLETE'
GROUP BY u.email
ORDER BY in_tokens DESC;
```

Template proposals (Phase 16) are the other thing that spends money per use, and they record tokens in
`FieldProposal`, not `ExtractionRun`. Add them to the shape above:

```sql
-- proposal spend for the last 30 days, per user
SELECT u.email, count(*) AS proposals, sum(p."inputTokens") AS in_tokens, sum(p."outputTokens") AS out_tokens
FROM "FieldProposal" p
JOIN "Template" t ON t.id = p."templateId"
JOIN "Book"     b ON b.id = t."bookId"
JOIN "User"     u ON u.id = b."userId"
WHERE p."finishedAt" > now() - interval '30 days'
GROUP BY u.email
ORDER BY in_tokens DESC;
```

A proposal is one request per specimen, about $0.004 on 3.5 Flash for a card. Failed proposals count too,
because a response that didn't validate was still paid for. `FieldProposal.rawResponse` is kept: it is a short
field list, not a page of values, and it is outside the 30-day strip below.

**Build the quota when both are true:** extraction on the server key is a cost line worth naming in a
month, and the query above has enough history to set a number that is not a guess. The unit — documents,
pages or tokens — is still open (docs/07 Part C, question 12). Until then, the exposure is bounded by
`SIGNUP_ALLOWED_EMAILS` and by nothing else. **The quota is what has to exist before that list is
removed and sign-up opens.**

### `rawResponse` retention

`ExtractionRun.rawResponse` holds the full model response for every run, for debugging. The Phase 9
storage lifecycle covers photo **objects**, not this JSON, so it grew in Postgres without limit
(decision 63).

- **Failed runs keep it for ever.** That is when it is actually wanted.
- **Successful runs lose it after 30 days**, in the daily `storage.cleanup`. Nothing else about the run
  changes: the token counts, timings, `photoIds` and raw values all stay, so cost history and provenance
  are unaffected.
- As built: `stripOldRawResponses` (`lib/storage/lifecycle.ts`, `RAW_RESPONSE_KEEP_DAYS = 30`) removes
  the `responses` key alone — `rawResponse - 'responses'` — so `summary` survives and with it the
  document's run state and the run history, which both read it. `pnpm storage:cleanup --dry-run`
  counts what the next real run would strip, and `--now=<iso>` moves the cutoff, which is how the
  predicate is checked before it is trusted. The job reports `strippedResponses` in its result line.

Check what it is costing before changing the window:

```sql
SELECT pg_size_pretty(sum(pg_column_size("rawResponse"))) AS raw_response_bytes,
       count(*) FILTER (WHERE "rawResponse" IS NOT NULL)  AS runs_with_response
FROM "ExtractionRun";
```

## 9. Deploying

Production is one host running `docker-compose.prod.yml` from `/opt/saakuu`: Caddy, app, worker, Postgres and
Redis. The host never builds. It holds three things: `.env` (secrets, template `deploy/env.example`),
`docker-compose.prod.yml` and `deploy/`.

**A push to `main` deploys itself** (`.github/workflows/ci.yml`, `deploy.yml`), unless it touches nothing but
`docs/` and Markdown files, which runs nothing:

1. `test`: typecheck, lint, unit and end-to-end tests. Nothing below runs unless this passes.
2. `image`: builds the image and pushes it to `ghcr.io/nanobyteruata/saakuu`, tagged with the commit sha and
   `latest`. The image is public and holds no secrets: `.dockerignore` keeps `.env*` out and the build has none set.
3. `deploy`: sends that commit's compose file and `deploy/` to the host over SSH and runs
   `deploy/release.sh <sha>` there. It pulls the image, starts `migrate`, then `app` and `worker`, and waits up to
   five minutes for the app's health check. The released sha is written to `/opt/saakuu/.release`.

A failed release exits non-zero with the `migrate` and `app` logs in the job output. The app is down for the few
seconds its container takes to be replaced. Caddy is restarted on every release: its Caddyfile is a bind-mounted
file, and compose does not notice a changed one.

**Changing a secret or setting.** Edit `/opt/saakuu/.env` on the host, then
`deploy/release.sh "$(cat .release)"`: the same image, recreated with the new values. Nothing is pushed.

**Roll back.** GitHub → Actions → Deploy → Run workflow, with the full sha of an earlier commit on `main`. Or on
the host: `cd /opt/saakuu && deploy/release.sh <sha>`. This changes the code, not the database: migrations are
not undone, so a rollback across a migration needs the older code to work with the newer schema.

**Secrets.** The `production` environment in the repository's settings, limited to the `main` branch:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the host's address |
| `DEPLOY_USER` | the SSH user that owns `/opt/saakuu` and may run `docker` |
| `DEPLOY_SSH_KEY` | private half of a key used for nothing else; its public half is in that user's `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <host>` |

**The domain.** `DOMAIN` in the host's `.env` is the only place the app learns its hostname: the Caddyfile and
`AUTH_URL` both come from it. Three things outside the host name it too, and each fails on its own when missed:

| Where | What | Fails as |
|---|---|---|
| DNS | A record for the domain and one for `www`, both at the host, **not proxied** | no certificate; `www` alone missing costs only the redirect |
| Storage bucket | the CORS rule in `deploy/r2-cors.json`, pasted into the bucket's settings | photo uploads refused by the browser |
| Google OAuth client | origin `https://<DOMAIN>`, redirect URI `https://<DOMAIN>/api/auth/callback/google` | `redirect_uri_mismatch` at sign-in |

Changing `DOMAIN` signs everyone out, since the session cookie belongs to the old hostname. Putting a CDN proxy
in front needs `TRUSTED_PROXY_HOPS=2` (§6) and end-to-end TLS at the CDN, or the per-address rate limits see one
address for everybody.

**A new host.** Install Docker, create `/opt/saakuu/.env` from `deploy/env.example` (`chmod 600`), point the DNS
records at it, add the deploy key, change `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`, then run the Deploy workflow.
Moving an existing deployment: restore the database first (§3). Install the backup cron from
`deploy/backup-db.sh`.

**A new repository or fork.** The image name is written out in `docker-compose.prod.yml`, `deploy/release.sh`
and `ci.yml`. GHCR creates a package private even for a public repository: after the first `image` job, make it
public in the package's settings, or give the host a read token and `docker login ghcr.io`. Until then the
release fails at `pull` and the old containers keep serving.

**CI's own services.** Tests run against the Postgres, Redis and MinIO in `docker-compose.yml`. MinIO comes from
Chainguard (`cgr.dev/chainguard/minio`) because MinIO's own images can no longer be pulled from Docker Hub or
quay.io; it runs as root there so a data volume made by the old image stays writable.
