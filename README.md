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

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test              # Vitest
pnpm test:e2e          # Playwright; reuses a running app on :3000 or starts `pnpm dev`
```

First Playwright run: `pnpm exec playwright install chromium`.
