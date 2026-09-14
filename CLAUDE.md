# SaaKuu — Project Conventions

Read `docs/` before writing code. Start with `docs/01-product-spec.md`, then
`docs/02-data-model.md`. `docs/06-build-plan.md` defines the order of work.

## What this product is

An assisted data-entry tool. Operators photograph handwritten physical forms and
tables (mostly Burmese), configure a Template describing the document, run AI
extraction, then **review and correct every cell** against the source photo, and
export CSV.

The AI is an assistant, not an oracle. Handwriting error rates of 40–50% are
expected for non-English script. The product's value is measured in **seconds per
reviewed cell**, not in extraction accuracy alone. Every design decision should
reduce reading, typing, and eye movement for a human who is checking the work.

Two rules follow from this and must never be violated:

1. **Never silently overwrite a human edit.** Re-extraction proposes; humans dispose.
2. **The AI transcribes, it does not normalise.** Raw values are stored exactly as
   read. All conversion (numerals, dates, fractions, concatenation) happens in a
   deterministic transform layer that can be re-run for free.

## Stack

- Next.js 15 (App Router) + TypeScript strict
- PostgreSQL + Prisma
- Auth.js v5 — Google OAuth + email/password credentials, database sessions
- Resend for transactional email, behind `lib/email` (`EMAIL_TRANSPORT`: resend | log | test)
- BullMQ + Redis for the job queue; a separate long-running worker process
- S3-compatible object storage (MinIO in dev, any S3 in prod)
- Tailwind + shadcn/ui
- TanStack Table + TanStack Virtual for the output table
- dnd-kit for row reordering
- Zod for all input validation, shared between client and server
- Vitest for unit tests, Playwright for a small number of E2E flows
- Gemini via `@google/genai` (Gemini 2.5 Flash default, Pro as the second option)

## Architecture rules

- **Server-side first.** Data mutations go through Server Actions or Route Handlers,
  never direct DB access from client components.
- **Never run extraction in a request handler.** It is always enqueued to BullMQ and
  executed by the worker. The API returns a job reference immediately.
- **The AI provider sits behind an interface** (`lib/ai/provider.ts`). Gemini is one
  implementation. No Gemini types leak past that boundary.
- **All prompts are versioned** and live in `lib/ai/prompts/`. Every ExtractionRun
  records the `promptVersion` used.
- **IDs are cuid2 everywhere.** Mappings, rows, and cells reference entities by ID,
  never by name or label. Renaming anything must never break anything.
- **Soft delete** (`deletedAt`) for Book, Template, Field, OutputColumn, Document.
  Hard delete only for Photos (storage cost) and only after a grace period.
- **Money/precision:** all numeric output values are stored as text in the raw layer
  and only parsed during transform. Never round-trip a number through a float.

## Code layout

```
app/                     routes (App Router)
  (auth)/                sign-in, sign-up, reset
  (app)/books/           book list
  (app)/books/[bookId]/  book detail: table | templates | documents | settings
components/
  ui/                    shadcn primitives
  auth/                  sign-in, sign-up, verify, forgot, reset forms
  shell/                 top bar, user menu, sign-out confirmation
  table/                 output table, cells, virtualisation
  review/                row review + column sweep
  photo/                 uploader, editor (crop/rotate/deskew), viewer
lib/
  ai/                    provider interface, gemini impl, prompts, schemas
  transform/             raw -> row engine, normalisers, validators
  db/                    prisma client, query helpers
  auth/                  Auth.js config, guards, session helpers, account service, tokens
  email/                 EmailSender interface, Resend/log/test transports, templates
worker/                  BullMQ worker entrypoint + processors
prisma/schema.prisma
docs/
```

## Conventions

- UI language is English only. Data values may be any language; use `lang` attributes
  and a font stack that includes `Noto Sans Myanmar` for value display.
- Dates in the UI are ISO (`YYYY-MM-DD`). Stored dates are `timestamptz`.
- All list endpoints are paginated (cursor-based). Never `findMany` without a take.
- The output table and documents list are virtualised. Assume up to a few thousand
  rows per book.
- Every destructive action shows a confirmation modal that states **exact counts**
  ("This clears 412 cells, 38 of which you have edited"), not generic warnings.
- Error messages are shown to the user in plain language; stack traces go to logs.

## Definition of done for any feature

- Zod schema for input, validated server-side
- Authorisation check: the acting user owns the Book (see `lib/auth/guards.ts`)
- Loading, empty, and error states in the UI
- Optimistic update only where rollback is safe
- No `any`, no unchecked `!`
- Tests only as allowed by the testing policy in `docs/06-build-plan.md` (minimal until launch)
