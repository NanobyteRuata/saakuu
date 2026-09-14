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

The auth E2E test needs the app running with `EMAIL_TRANSPORT=test`, e.g.:

```sh
EMAIL_TRANSPORT=test AUTH_URL=http://localhost:3001 pnpm dev --port 3001
E2E_BASE_URL=http://localhost:3001 pnpm test:e2e
```
