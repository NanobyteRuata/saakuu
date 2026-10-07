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

## 8. AI cost, keys and credits (Phase 12, Phase 21, Phase 22)

Extraction is the only thing this product does that costs money per use, and until Phase 12 none of it
was visible: `ExtractionRun.inputTokens` and `outputTokens` had been recorded since Phase 5 and were
surfaced nowhere, there was no quota and no per-user cap, and a single server key meant every user's
extraction landed on the owner's bill.

**One key in use** (decision 79). Every reading runs on the deployment's `GEMINI_API_KEY`, so every
reading is on the owner's bill. Two things follow, and both are configuration:

- **`SIGNUP_ALLOWED_EMAILS` is the first spend limit.** The invite list: comma-separated addresses, or `*`
  for anyone. Until credits are switched on (below) it is the only bound on what the key spends. It is asked
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
5. The spend queries below are run weekly. Their history is what sets a price, `SIGNUP_CREDITS` and the cap.
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

- **They were wrong until 2026-10-06**, by about four times, and were corrected against a real bill
  (docs/06 Phase 22, as built). Credits are charged from these constants, so a wrong price is a wrong
  charge: check one real reading's tokens against Google's bill after any model or price change.
- **Gemini 3.7 Flash's price rises on 2027-01-01**, from $0.75 / $3.75 to $1.50 / $7.50. That is
  already in `priceChanges` and applies itself on the day. Check the first January bill against it:
  an announced price can change before it arrives.

Output tokens are estimated from the book's **own** completed runs (average output tokens per page),
falling back to constants until a book has read something. That matters most on TABLE registers, where a
page holds however many rows the paper holds — a single constant is wrong by multiples in both
directions, and a money figure that is wrong by multiples is worse than showing tokens.

### Credits (Phase 22, decision 81)

A credit is **$0.02 of reading at list price**, about one page of a simple form (`CREDIT_MICRO_USD`,
`lib/credits/rate.ts`). Every reading on the deployment's key is charged what its tokens really cost,
and holds its estimate while it is queued or running. Three settings, all optional, all in `.env`:

| Variable | What it does | Unset |
|---|---|---|
| `SIGNUP_CREDITS` | Free credits a new account starts with. **Setting it is what switches balances on**: dialogs show credits, starts are refused when they don't fit, `/account` gains a Credits section. | Usage is recorded; nothing is enforced or shown. |
| `DAILY_CREDIT_CAP` | The most every user together may read in one UTC day, in credits. | No ceiling. |
| `CREDIT_REQUEST_TO` | Where `Request more` is emailed. | The button isn't offered. |

- **Switching on, in order.** Deploy with all three blank and let usage record. Before setting
  `SIGNUP_CREDITS`, grant every existing account: their recorded readings have already taken their
  balance below zero, and the free credits alone may not bring it back. Then set the three and release
  (§9, *Changing a secret or setting*).
- **Opening sign-up.** `SIGNUP_ALLOWED_EMAILS=*` in production needs `SIGNUP_CREDITS` and
  `DAILY_CREDIT_CAP` both set, or the app does not start. Per-user credits bound one account; only the
  cap bounds many. Exposure per day is at most the cap times $0.02, and each sign-up's free credits cost at most
  `SIGNUP_CREDITS` times $0.02.
- **Giving someone credits.** No restart, effective at once:

  ```sh
  cd /opt/saakuu
  docker compose -f docker-compose.prod.yml exec worker pnpm credits:grant someone@clinic.org 250 "paid by transfer 2026-10-06"
  ```

  The amount may be decimal, and negative to correct a mistake. The note is shown to the user beside
  the line. Locally it is `pnpm credits:grant …`. Until credits are sold, this after being paid by
  hand is the whole purchase flow.
- **When the cap is hit** every start is refused with "SaaKuu has read as much as it can today" and the
  app logs `daily credit cap reached` at `error` level. Nobody's credits are touched. Watch for that
  line alongside the key-refused one; it means either real demand or someone farming free accounts,
  and the ledger query below tells which.
- **Free credits are given the first time an account's balance is looked at**, not at sign-up, once
  per account for ever. Raising `SIGNUP_CREDITS` later does not top up accounts that already have theirs.
- **A reading stops being held after three days**, and **the worker stops a batch when its owner's
  balance goes below zero**: the pages left fail with "You've run out of credits" and nothing is
  charged for them. A grant followed by `Retry` in the run drawer picks them up.
- **A failed reading is free to the user** even where the provider billed it, and so is a
  `Propose fields` that found no fields. That cost is the
  deployment's, and belongs in the price of a credit when there is one.
- **Changing a model's price** (`lib/ai/models.ts`) changes what future readings charge. The ledger
  keeps what each past reading cost and was charged, and is never rewritten.

```sql
-- who is using what, last 30 days: credits charged, real cost, and what is left
SELECT u.email,
       count(*) FILTER (WHERE e.kind = 'USAGE')                                   AS readings,
       coalesce(sum(e.pages) FILTER (WHERE e.kind = 'USAGE'), 0)                  AS pages,
       round(-coalesce(sum(e."milliCredits") FILTER (WHERE e.kind = 'USAGE'), 0) / 1000.0, 1) AS credits_used,
       round(coalesce(sum(e."costMicroUsd"), 0) / 1000000.0, 4)                   AS cost_usd,
       round((SELECT sum(x."milliCredits") FROM "CreditEntry" x WHERE x."userId" = u.id) / 1000.0, 1) AS balance
FROM "User" u
JOIN "CreditEntry" e ON e."userId" = u.id AND e."createdAt" > now() - interval '30 days'
GROUP BY u.id, u.email
ORDER BY cost_usd DESC;
```

`credits_used / pages` per user is what a page of *their* paper costs — the number to price from, and
the reason the unit is not pages: a table register runs several times a form.

### Thinking (Phase 23, decision 82)

`AI_THINKING` is how long the model thinks before it answers, for every reading: `default`,
`minimal`, `low`, `medium` or `high`. **Unset means `low`.** `default` sends no setting and these
models then think at medium. Thinking is billed as output, and on a field proposal it was two thirds of the cost: the
same page cost $0.054 at `default` and $0.018 at `low`, with the same 28 columns.

- **Changing it:** edit the host's `.env` and restart the worker and the app.
- **Checking it:** `pnpm ai:stats [count]` lists recent readings with the prompt version, the setting
  each was made at, image and text tokens in, thinking and answer tokens out, and cost at list
  price. Only compare readings with the same model, prompt version and setting.
- **Not compared:** extraction at `default` against `low` (docs/06 Phase 23, Still open). If
  extraction gets worse after this ships, that is the first thing to try.
- **Watch `out: thinking`.** Nothing else bounds it. One proposal of a blurry photo thought for
  62,910 tokens and cost $0.58. `Propose fields` is capped at 24,000 output tokens an ask;
  extraction is not.
- **Watch `in: image`.** A page should be about 1,080 tokens. If it rises above 1,120 the credit
  hold is too low: correct `IMAGE_TOKENS_PER_PAGE` in `lib/extraction/plan.ts`.

### Watch the bill

The ledger above is the readout since Phase 22. The two queries below predate it and still work; they
read the token columns on the runs themselves, so they miss readings whose documents were deleted,
which the ledger does not:

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

A proposal is one request per specimen, about $0.03 on 3.5 Flash for a one-page form (measured:
1,766 tokens in, 2,870 out, billed $0.0285). Failed proposals count too,
because a response that didn't validate was still paid for. `FieldProposal.rawResponse` is kept: it is a short
field list, not a page of values, and it is outside the 30-day strip below.

**What is still open is the price.** Set what a credit sells for when the ledger has enough history
that the number is not a guess, and when `Request more` has shown who would pay and how
(docs/06 → Post-v1, *Buying credits*).

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
