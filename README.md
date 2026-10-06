# SaaKuu

Assisted data entry for handwritten forms and tables. Start with `CLAUDE.md` and `docs/`.

## Run everything

```sh
docker compose up --build
```

Starts Postgres, Redis, MinIO (bucket `saakuu` created), applies migrations, then the
app on http://localhost:3000 and the worker.

Check it:

```sh
curl localhost:3000/api/health                 # database, redis, storage
curl -X POST localhost:3000/api/health/queue   # enqueue a no-op job, wait for the worker
```

Host ports default to 3000 / 5433 / 6380 / 9002 (MinIO console 9003). Override with
`APP_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`.

## Local development

```sh
cp .env.example .env
docker compose up -d postgres redis minio minio-init
pnpm install
pnpm db:migrate        # apply / create migrations
pnpm dev               # app
pnpm worker:dev        # worker, in another terminal
pnpm job:noop          # round-trip a no-op job through the worker
```

## Auth

Auth.js v5: email + password and Google, database sessions (30-day rolling).
Set `AUTH_SECRET` (`openssl rand -base64 33`) and `AUTH_URL` in `.env`; see `.env.example`.

- **Email** goes through `EMAIL_TRANSPORT`: `resend` (needs `RESEND_API_KEY`), `log` (links
  printed to the server log), or `test` (in-memory, readable at `/api/test/outbox?to=`, 404
  otherwise and refused in production). With Resend, `onboarding@resend.dev` only delivers
  to your own Resend account address until you verify a domain and change `EMAIL_FROM`.
- **Google** is enabled when `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are both set. Add
  `<AUTH_URL>/api/auth/callback/google` as an authorised redirect URI.
- **Account linking:** Google sign-in joins an existing account with the same email only
  when that account's email is verified; otherwise it is blocked until the user confirms
  the email.

Manual Google linking check: register with your Gmail address using a password, confirm the
email, sign out, then "Continue with Google". Expect one `User` row for that email and one
`Account` row with `provider = 'google'` pointing at it.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test              # Vitest
pnpm test:e2e          # Playwright; reuses a running app on :3000 or starts `pnpm dev`
```

First Playwright run: `pnpm exec playwright install chromium`.

The E2E tests need the app running with `EMAIL_TRANSPORT=test` (each test registers a fresh
account through the outbox) and a worker with `AI_PROVIDER=fake`. The full flow
(`e2e/full-flow.spec.ts`: sign in → book → template → upload → extract → review → export) never
calls Gemini. E.g.:

```sh
AI_PROVIDER=fake pnpm worker
EMAIL_TRANSPORT=test AUTH_URL=http://localhost:3001 pnpm dev --port 3001
E2E_BASE_URL=http://localhost:3001 pnpm test:e2e
```

Stop any other `pnpm dev` and `pnpm worker` for this checkout first: two dev servers share `.next`,
and a worker using Gemini on the same Redis would take the test's extraction jobs.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests and every E2E spec the same way.

## Demo data

```sh
pnpm db:seed-demo      # demo@example.com / demo-password-123: a Burmese clinic register and vaccination cards
pnpm db:seed-table     # table-demo@example.com: 3,000 rows for checking table performance
```

## Deploying

A push to `main` that passes CI builds the image, publishes it to GHCR and releases it on the production host.
Rolling back is running the Deploy workflow with an older commit's sha. The pipeline, its secrets, the domain
checklist and setting up a new host: [docs/09-operations.md](docs/09-operations.md) §9.

## Operations

Backups, restore, scheduled jobs (stale-run reaper, storage cleanup), rate limits and log fields:
[docs/09-operations.md](docs/09-operations.md). Storage cleanup by hand:

```sh
pnpm storage:cleanup --dry-run
```
