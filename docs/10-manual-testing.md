# 10 — Manual Testing

A full manual test plan for SaaKuu as shipped through Phase 20. Automated tests stay minimal by policy
(docs/06 → Testing policy), so **this document is how acceptance criteria are checked**.

Each case has an ID (`AUTH-03`), steps, and the expected result. Record a failure by its ID, what you saw, the
browser, the viewport width, and the **Reference** or `X-Request-Id` if an error was shown (docs/09 §7).

**Suggested passes:**

| Pass | When | Scope | Time |
|---|---|---|---|
| **Smoke** | Every deploy | §2, §17 release path | ~30 min |
| **Full** | Before a release, after a phase ships | Everything, fake AI | ~1 day |
| **Real AI** | Before a release, after prompt or provider changes | Cases tagged **[Gemini]** | ~1 hour, costs a few cents |

The two rules that must never break are tested in more than one place and are marked **[CRITICAL]**:

1. Never silently overwrite a human edit.
2. The AI transcribes, it does not normalise (raw values are stored exactly as read).

---

## 1. Setup

### 1.1 Stack

```sh
cp .env.example .env              # first time only; set AUTH_SECRET (openssl rand -base64 33)
docker compose up -d postgres redis minio minio-init
pnpm install
pnpm db:migrate
pnpm dev                          # app on :3000
pnpm worker:dev                   # worker, second terminal
```

For most of this plan, run the worker with the **fake AI provider**: it is free, deterministic and never touches
the network.

```sh
AI_PROVIDER=fake pnpm worker      # instead of pnpm worker:dev
```

The fake provider answers:
- a near-white page as `EMPTY`;
- otherwise a form as one record and a table as two rows, with `<field label> 1`, `<field label> 2` for each
  Extract field, ticks on alternate mark fields, and confidence 0.5 (so every value shows low confidence);
- a field proposal as twelve Burmese form fields, or six table columns.

`AI_FAKE_BEHAVIOUR` switches it to `error`, `rate-limited` or `slow` (answers after 90 s). The worker reads env
once at start: **restart it after changing any of these.**

If your normal dev server and a Gemini worker are already running, don't share them with a test run: start the
test app on another port and the fake worker on another Redis database so neither steals the other's jobs:

```sh
AUTH_URL=http://localhost:3100 REDIS_URL=redis://localhost:6380/1 pnpm dev --port 3100
AI_PROVIDER=fake REDIS_URL=redis://localhost:6380/1 pnpm worker
```

(Two `next dev` processes in one checkout share `.next`; use a separate `git worktree` if you see build clashes.)

### 1.2 Email

`EMAIL_TRANSPORT=log` (the default in `.env.example`) prints every verification and reset link in the app's log.
Copy the link from there. `EMAIL_TRANSPORT=resend` sends real mail (only to your own Resend address until a
domain is verified) — use it once per release to check deliverability (AUTH-16).

### 1.3 Database access

```sh
psql postgresql://saakuu:saakuu@localhost:5433/saakuu
```

Useful queries are in Appendix A. Table and column names are quoted (`"Cell"."isEdited"`).

### 1.4 Accounts

| Name | How | Used for |
|---|---|---|
| **U1** | Sign up through the UI (AUTH-01) | Most of the plan |
| **U2** | A second sign-up, separate browser profile | Isolation tests (§15) |
| **Demo** | `pnpm db:seed-demo` → `demo@example.com` / `demo-password-123` | Review, sweep, Pace, table states: a Burmese clinic register (TABLE, 8 pages × 12 rows) and 4 vaccination cards (FORM), some edits and reviews already in place |
| **Table demo** | `pnpm db:seed-table` → `table-demo@example.com` | 3,000 rows for performance (§16) |

Re-running a seed script deletes and recreates its own book, so it is also the fastest reset.

### 1.5 Test files

Put these in one folder before starting:

| File | Purpose |
|---|---|
| `form.jpg` | A photo of a handwritten form. `e2e/fixtures/form.jpg` works. |
| `register-1.jpg`, `register-2.jpg` | Two pages of a handwritten table/register, ideally with a numbered `No.` column, a ditto mark, and a total row |
| `burmese-card.jpg` | A real handwritten Burmese card with Burmese digits (for [Gemini] cases) |
| `blank.png` | A plain white image (the fake provider reads it as `EMPTY`) |
| `phone.heic` | An iPhone HEIC photo, ideally shot in portrait (checks EXIF orientation) |
| `photo.webp`, `photo.png` | Other accepted image types |
| `three-pages.pdf` | A 3-page PDF |
| `big.jpg` | Any image over 25 MB |
| `notes.txt`, `anim.gif` | Unsupported types |
| `crooked.jpg` | A page shot at a visible angle (deskew) |

### 1.6 Browsers and widths

Run the full pass in Chrome. Repeat §3 (shell) and §13 (review) in Safari and Firefox. Use devtools device mode for
widths: **390** (phone), **1279**, **1280**, **1600**, **1920**. Keep one private window available for storage tests.

---

## 2. Health and smoke

| ID | Steps | Expected |
|---|---|---|
| OPS-01 | `curl localhost:3000/api/health` | `database`, `redis`, `storage` all `ok` |
| OPS-02 | `curl -X POST localhost:3000/api/health/queue` | Completes a no-op job through the worker; fails or times out plainly if the worker is stopped |
| OPS-03 | Open `http://localhost:3000` signed out | Redirected to sign-in |
| OPS-04 | Open any `/api/...` response in devtools → Network | Every response carries an `X-Request-Id` header |
| OPS-05 | Open `/no-such-page` | `Page not found` with a link to the books list |

---

## 3. Authentication

### Sign-up and verification

| ID | Steps | Expected |
|---|---|---|
| AUTH-01 | Sign-up → enter an email and password `abc` | Inline requirements show which rules pass: at least 8 characters, a letter, a number. `Create account` refuses with a plain message |
| AUTH-02 | Enter a valid password (`test-pass-123`), `Create account` | `Check your email`. A verification link appears in the app log |
| AUTH-03 | Before verifying, sign in with that email and password | `Confirm your email address before signing in…`, with `Send a new confirmation link` |
| AUTH-04 | Press `Send a new confirmation link` | "If that account needs confirming, a new link is on its way." A new link is logged |
| AUTH-05 | Open the verification link → `Confirm email` | `Email confirmed` → `Sign in`. Signing in now works and lands on the books list |
| AUTH-06 | Open the same verification link again | Refused plainly (single use); nothing breaks |
| AUTH-07 | Open `/verify` with no token | `Confirmation link missing` with a way back to sign-in |
| AUTH-08 | Sign up again with the **same** email | Same `Check your email` response as a new account (no account discovery). Only one `User` row for that email |
| AUTH-09 | Sign up with `Test@Example.com ` (caps, trailing space) | Stored lowercase and trimmed; signing in with `test@example.com` works |

### Sign-in

| ID | Steps | Expected |
|---|---|---|
| AUTH-10 | Sign in with a wrong password | "That email and password don't match an account." |
| AUTH-11 | Sign in with an email that has no account | The same message as AUTH-10 (no account discovery) |
| AUTH-12 | Wrong password 11 times in a row from one browser (rate limiting on, not from loopback in production mode — see note) | "Too many sign-in attempts. Wait 15 minutes and try again, or reset your password." |
| AUTH-13 | Visit `/books` signed out, then sign in | Lands back on `/books` |
| AUTH-14 | Visit `/sign-in?callbackUrl=https://example.org` and sign in | Stays on SaaKuu; never redirected off-site |

> Rate limits on per-address rules are skipped for loopback outside production (docs/09 §6). To see AUTH-12 locally,
> the per-email limit still applies; otherwise test it on a staging deploy.

### Password reset

| ID | Steps | Expected |
|---|---|---|
| AUTH-15 | `Forgot password` → enter U1's email | `Check your email`; a reset link is logged. An unknown email gets the same response and no link |
| AUTH-16 | **[Resend]** With `EMAIL_TRANSPORT=resend`, repeat AUTH-02 and AUTH-15 to your own address | Both emails arrive, links work, sender matches `EMAIL_FROM` |
| AUTH-17 | Sign in U1 in two browsers. In one, open the reset link, set a new password | "This signs you out of SaaKuu everywhere." After saving, the **other** browser is signed out on its next navigation |
| AUTH-18 | Reuse the same reset link | Refused (single use) |
| AUTH-19 | Make a reset link, then expire it in psql: `UPDATE "VerificationToken" SET expires = now() - interval '1 minute' WHERE identifier = '<email>' AND purpose = 'PASSWORD_RESET';` (or wait an hour). Open the link | Refused as expired, with `Request a new link` |
| AUTH-20 | Sign in with the old password | Refused; the new one works |

### Google and account linking

Needs `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` and `<AUTH_URL>/api/auth/callback/google` as a redirect URI.

| ID | Steps | Expected |
|---|---|---|
| AUTH-21 | With Google unset, open sign-in | No Google button |
| AUTH-22 | `Continue with Google` with a Gmail that has no SaaKuu account | Signed in; one `User`, one `Account` with `provider = 'google'` |
| AUTH-23 | Sign up with a password using your Gmail, **verify it**, sign out, `Continue with Google` | Signed into the same account. psql: one `User` for that email, one `Account` row for google pointing at it |
| AUTH-24 | Sign up with a password using another Gmail, **don't verify**, then `Continue with Google` | Blocked: "This email is already used by another sign-in method…". No link is made until the email is confirmed |
| AUTH-25 | Cancel on Google's consent screen | "Sign-in was cancelled or not allowed." |

### Sign-out and sessions

| ID | Steps | Expected |
|---|---|---|
| AUTH-26 | Avatar → menu shows the email, `Account` (`Account and AI key` when `ENCRYPTION_KEY` is set), `Sign out` → `Sign out` | Modal `Sign out of SaaKuu?`; `Cancel` keeps you in; `Sign out` returns to sign-in |
| AUTH-27 | After signing out, press Back | Protected pages redirect to sign-in rather than showing cached data |
| AUTH-28 | psql: check `"Session"."expires"` for U1, use the app, check again | Expiry rolls forward (30-day rolling session) |

### Invite-only sign-up (Phase 21)

Set `SIGNUP_ALLOWED_EMAILS=invited@example.com` and restart the app. Unset it again afterwards: the rest of
this plan signs up freely.

| ID | Steps | Expected |
|---|---|---|
| AUTH-29 | Open sign-up | Says SaaKuu is invite-only and to use the address you were invited with |
| AUTH-30 | Sign up with an address that isn't on the list | Refused in place: `SaaKuu is invite-only for now. Ask for an invitation with this email address.` No `User` row, no email |
| AUTH-31 | Sign up with `Invited@Example.com ` (caps, trailing space) | `Check your email`, as AUTH-02. The list is matched trimmed and lowercase |
| AUTH-32 | **[Google]** `Continue with Google` with a Gmail that isn't on the list and has no account | Back on sign-in with the invite-only message naming the Google account. No `User`, no `Account` row |
| AUTH-33 | Sign in as U1 (created before the list was set, not on it), by password and by Google | Both work. The list gates creating an account, never an existing one |
| AUTH-34 | With the list set, `Forgot password` for an address not on it | Same `Check your email` as always; no link, no account discovery |
| AUTH-35 | As U1 (signed in, not on the list), open an Extract dialog and `Propose fields` | Both say reading isn't switched on for this account, and their buttons stay disabled. Books, review and export all still work |
| AUTH-36 | Add U1's address to the list, restart app and worker, repeat AUTH-35 | Both dialogs give an estimate and run |
| AUTH-37 | Set `SIGNUP_ALLOWED_EMAILS=" "`, then `a@x.com, bob`, and start the app | Refuses to start each time, naming the variable: lists no addresses / `bob` is not an address |
| AUTH-38 | `NODE_ENV=production`, `AI_PROVIDER=gemini`, a `GEMINI_API_KEY`, list unset; start the app | Refuses to start: required in production. With `SIGNUP_ALLOWED_EMAILS=*` it starts and sign-up is open |

---

## 4. Shell, layout and navigation

| ID | Steps | Expected |
|---|---|---|
| SHELL-01 | Open a book at 1280 and 1600, visit all four workspaces and Settings | The page itself never scrolls. Only panes scroll. No horizontal page scroll at 1280 |
| SHELL-02 | Look at the nav | `Templates`, `Documents N`, `Review N left`, `Result Table N rows`, gear. Settings reachable only from the gear, and `/books/:id/settings` works by URL |
| SHELL-03 | In Review, drag the pane divider; reload | Split is kept. Double-click the divider resets it |
| SHELL-04 | Collapse a pane, reload | Stays collapsed |
| SHELL-05 | Repeat SHELL-03 in a private window, then with site data cleared, then with storage blocked in browser settings | Workspace renders with default sizes and never errors |
| SHELL-06 | In the template workspace at 1600 drag the 3-pane split; resize to 1280 and drag the 2-pane split; go back to 1600 and reload | Each shape keeps its own split; no `Invalid 2 panel layout` error, no error page |
| SHELL-07 | Set the window to **1279px** | Upload-only screen: plain line that reviewing needs a wider screen; no workspaces, no table |
| SHELL-08 | Set it to **1280px** | Two-pane workspaces, no horizontal scroll |
| SHELL-09 | Copy a deep link (a template's Mapping, a Review `?row=`, a sweep `?column=`) into a new tab | Opens exactly there; Back button works through workspaces |
| SHELL-10 | Open a new book (no templates) | Lands on Templates |
| SHELL-11 | In a book with templates, go to Result Table, go back to the books list, open the book again in a **new** browser session | Lands on Result Table (remembered per user per book). Within one session, Back is never caught in a redirect loop |
| SHELL-12 | Start an extraction, then watch the nav without refreshing | `Documents`, `Review N left` and `Result Table N rows` update when the run finishes |
| SHELL-13 | Stop Postgres (`docker compose stop postgres`), load a book page | Error boundary: says data is safe, `Try again`, and a `Reference`. Find that reference in the app log. Start Postgres again, `Try again` recovers |

---

## 5. Account page (`/account`)

| ID | Steps | Expected |
|---|---|---|
| ACC-01 | With `ENCRYPTION_KEY` blank (the launch setting), open `/account` | No `AI key` section at all. `Reading so far` counts documents and readings and shows **no money** |
| ACC-02 | Set `ENCRYPTION_KEY` (`openssl rand -base64 32`), restart app and worker. Paste a key, `Save key` | `Your API key is saved.` Only `····` plus the last 4 characters is shown |
| ACC-03 | psql: `SELECT "aiApiKeyCipher","aiApiKeyHint" FROM "User" WHERE email='…'` | Cipher is not the plain key; hint is the last 4 |
| ACC-04 | Grep the app and worker logs for the key | Not present anywhere |
| ACC-05 | `Replace with a different key`, save | New hint shown |
| ACC-06 | Remove the key | `Key removed. Reading now uses this server's key.` (or, with no server key, says nothing can be read until you save your own) |
| ACC-07 | Open an Extract dialog after each of ACC-02 and ACC-06 | With a key: `About $0.05, about 2 minutes.` and `Uses your own AI key (····1234).` Without: time only, no money, no key line |
| ACC-08 | **[Gemini]** Save an invalid key, extract one document | The run fails with a plain message pointing back to the account page (`KEY_REFUSED`); it does **not** fall back to the server key |
| ACC-09 | Change `ENCRYPTION_KEY`, restart, extract with a user whose key was saved under the old one | Run fails asking to save the key again; no fallback to the server key |
| ACC-10 | After some completed runs, read "Reading so far" with your own key saved | A money figure stated as an estimate, with document and reading counts |
| ACC-11 | Save a key (ACC-02), then blank `ENCRYPTION_KEY`, restart app and worker, extract one document | It reads on the server's key. The saved key is ignored, not reported as broken |
| ACC-12 | **[Gemini]** With `ENCRYPTION_KEY` blank, set `GEMINI_API_KEY` to a bad value, restart the worker, extract | The run fails saying it is a problem on SaaKuu's side, not with the pages. Nothing tells the operator to fix a key. The worker log has `server AI key is missing or refused` at `error` level, with `KEY_REFUSED` |

---

## 6. Books

| ID | Steps | Expected |
|---|---|---|
| BOOK-01 | New account, books list | Empty state explains the idea in two sentences, `Create your first book` |
| BOOK-02 | Create a book with an empty name, then a 201-character name | Refused with plain messages |
| BOOK-03 | Create `Q1 register` | One step; lands on the Templates workspace |
| BOOK-04 | Click the book name in the header, rename, press Enter; reload | Name saved. Escape during editing cancels |
| BOOK-05 | Books list after data exists (use Demo) | Each book: name, column/document/row counts, updated date, `N of M cells reviewed` with a bar, `Resume review`. A fully reviewed book says `All reviewed`; a book with nothing read shows neither |
| BOOK-06 | `Resume review` on a half-reviewed book | Opens Review directly at the first unreviewed cell, without loading the Result Table first |
| BOOK-07 | Select 2 books → `Delete (2)` | Modal states exact counts of books, documents and rows (e.g. "Delete 2 books, 47 documents and 1,203 rows?"). Confirm is disabled until counts load |
| BOOK-08 | Confirm the delete; psql `SELECT id,"deletedAt" FROM "Book"` | Books gone from the list; rows still exist with `deletedAt` set (soft delete) |
| BOOK-09 | Settings (gear) → Danger zone → delete the current book | Counted confirmation; after it, back on the books list |

### New book from this one (Phase 17)

Prepare a source book with 2 templates (one with nested and selection groups), mapped columns, 2 glossary entries,
3 rules (one `CROSS_COLUMN`), a non-default era, custom export tokens, and some documents and rows.

| ID | Steps | Expected |
|---|---|---|
| BOOK-10 | Copy icon on the source book | `New book from "…"`, name defaulting to `<name> (copy)`, counts of templates, columns, mappings, glossary entries and rules, and "Documents, photos and rows are not copied." `Create book` disabled until counts arrive |
| BOOK-11 | Create it | New book has both templates (structure and every group setting intact), all columns, all mappings, glossary, rules, era and export tokens. **Zero** documents and rows |
| BOOK-12 | Templates in the copy | Listed in the same order as the source |
| BOOK-13 | Delete a column in the source, then copy again | Rules and mappings on the deleted column are not copied, and the counts said so before copying |
| BOOK-14 | Edit a template in the copy | Source book is unchanged |

---

## 7. Templates

### Templates workspace

| ID | Steps | Expected |
|---|---|---|
| TPL-01 | Empty Templates workspace | Real empty state with `Create your first template` |
| TPL-02 | Create a **Form** `Household card` and a **Table** `Clinic register` | Each opens in the template workspace |
| TPL-03 | Template cards | Name, `[Form]`/`[Table]`, config badge `Draft`, run badge `Never run`, field count, document and photo counts, icon actions edit / duplicate / delete. No upload or extract action on the card |
| TPL-04 | Click the document count | Opens Documents filtered to that template |
| TPL-05 | While a run is going, watch a card | Run badge `Running n/m`, refreshes itself, then `Complete` / `Partial` / `Failed` |

### Specimen and the paper on screen (Phase 15)

| ID | Steps | Expected |
|---|---|---|
| TPL-06 | In the empty template workspace, drop `form.jpg` into the photo pane | Uploads, processes, and shows the page large and zoomable beside the tree |
| TPL-07 | Open the photo editor from the pane, rotate 90°, save | Pane shows the rotated page after re-render |
| TPL-08 | With **zero fields** (or none set to Extract), hover `Test on this page` | Button is disabled; its tooltip says to add a field set to Extract first. Nothing is spent |
| TPL-09 | Resize to 1280 | Two panes: photo | tree; properties open **under** the selected row. The photo never shrinks below readable |
| TPL-10 | Resize to 1600 | Three panes: photo | tree | properties |
| TPL-11 | Template settings | A collapsed disclosure line (name + both badges). Opening it shows language, model, anchors, instructions and double extraction (disabled, "coming soon") |
| TPL-12 | Documents workspace, then Templates | The specimen is **not** in the Documents list, its search, the upload-day filter, the run drawer or the nav's document count. Template card shows `0 documents` and `1 specimen` |

### Specimens belong to the template (decision 78)

| ID | Steps | Expected |
|---|---|---|
| TPL-57 | New template → pick **two** photos at once in the empty pane | One specimen with `p1` `p2`, pages in the order picked |
| TPL-58 | Pane header image icon → add a third photo | Toast `Page 3 added to this specimen. Test again to read it.`; the pane shows page 3; an existing test reading now says `Read before your latest field changes` |
| TPL-59 | `+` (New specimen) → `Choose an uploaded page` → pick a read document of this template | A new specimen appears, unread. The source document is unchanged: same rows, edits and run history, still in Documents and the table |
| TPL-60 | `Choose an uploaded page` on a document still processing | Its button is disabled; the list says how many pages are still processing |
| TPL-61 | Test a specimen, then `Add to documents` without changing anything | Confirmation: `… with this reading (N values). Nothing is read again.` Confirm: the specimen and its `Test reading` stay; the copy is in Documents; no new run appears in the run drawer; the table shows its rows once built |
| TPL-62 | Test, edit a field label, then `Add to documents` | Confirmation says it's read again there, because your fields changed, with the time (and, on your own key, the cost and key line). Confirm: the copy is being read |
| TPL-63 | Test, change only a mapping, then back to Fields → `Add to documents` | Still `… with this reading … Nothing is read again.` (mappings don't make a test stale) |
| TPL-64 | Set every field to Manual (or remove the AI key), then `Add to documents` | Confirmation says it's added unread and why. The copy lands as `Not read yet` |
| TPL-65 | `Add to documents` a second time on the same specimen | Warning: `You already added this page to your documents on YYYY-MM-DD (1 copy).` Still allowed |
| TPL-66 | Double-click the confirm of `Add to documents` | Exactly one copy |
| TPL-67 | Crop the promoted copy's page in Documents | The specimen's page is unchanged |
| TPL-68 | Pane trash icon → confirm | Counted confirmation (`Removes this 2-page specimen …`). The specimen goes; the documents, including copies made from it, stay |
| TPL-69 | Reading pane | Heading `Test reading · stays with this template, not in your table` |

### Fields, groups and the tree

| ID | Steps | Expected |
|---|---|---|
| TPL-13 | Add bar: add fields `Name`, `Village`, `Age` | Appear in order; new rows scroll into view; default mode Extract; type Text |
| TPL-14 | Add a group `Sex`, then `M` and `F` into it as Mark fields | Adding a group switches the bar to adding fields into it. Inside a selection group the type defaults to Mark |
| TPL-15 | Group row `+` → type a label, Enter, another, Enter, Escape | Inline quick-add adds both and closes |
| TPL-16 | Drag a field up/down; drag right into a group; drag left out | Moves as described; the order survives reload |
| TPL-17 | Keyboard drag: focus a handle, Space, ↑/↓, →/←, Space | Same moves by keyboard. With a screen reader (VoiceOver), each step is announced by label, never by id |
| TPL-18 | Nest groups four levels deep | The fourth level is refused with a plain message. Moving a group into itself is refused |
| TPL-19 | Parent picker in the add bar | Parents that would refuse the item are greyed out |
| TPL-20 | Set `Sex` group to `One of`, `When nothing is ticked: Flag for review`, `When several are ticked: Error` | Saved; the panel explains the effect in one line and lists the option fields |
| TPL-21 | Try `One of` on a group containing a Text field | Unavailable, with the reason shown |
| TPL-22 | Change a field inside a selection group from Mark to Text | Refused with a plain message |
| TPL-23 | Delete a group with 2 fields and 1 subgroup | Confirmation: "2 fields and 1 group move up into … No fields are deleted." Fields are kept |

### Field properties and autosave

| ID | Steps | Expected |
|---|---|---|
| TPL-24 | Select a field, edit label/meaning/note, click another field | First field saves. **No** "Discard unsaved changes?" modal. Footer goes `Saving…` → `All changes saved` |
| TPL-25 | Repeat TPL-24 with devtools Network open | Exactly **one** `PATCH /api/fields/:id` per switch, not two |
| TPL-26 | Clear a field's label (invalid), click another field, come back | The invalid draft is restored with its message. Nothing typed was lost; nothing was saved |
| TPL-27 | Edit a field and immediately reload the tab while `Saving…` | Browser asks before leaving |
| TPL-28 | Set type to Choice with no choices | Refused until at least one choice exists |
| TPL-29 | Set a Mark field's symbols (`✓` → true, `✗` → false, `/` → count) | Saved and shown; switching type away clears them |
| TPL-30 | Date field → "Dates written with a two-digit year": flag / read in era's century / split at a year | Each shows a one-line example of what `30.8.20` becomes |
| TPL-31 | Table template: set `No.` as the sequence field | Only live Extract fields are offered; while it's the sequence field its mode can't change |
| TPL-32 | Modes | Chips are legible: Extract neutral, Skip muted/struck, Manual accented. Help text carries the Skip/Manual guidance (tables: add every column, set unwanted to Skip) |
| TPL-33 | Try to change a template's kind Form ↔ Table | Not offered / refused; duplicate as a new template is suggested |

### Field delete and restore

Needs a template that has mapped fields and extracted rows (do after §10).

| ID | Steps | Expected |
|---|---|---|
| TPL-34 | Delete a mapped field | Confirmation states which mappings break, which columns empty, rows and cells affected, and how many cells carry your edits |
| TPL-35 | Confirm | Mapping marked `Broken` with the reason; template badge `Conflicted` with a tooltip listing broken mappings and `Fix mappings`. Other mappings keep working |
| TPL-36 | psql: `SELECT count(*) FROM "RawValue" WHERE "fieldId"='<deleted field id>'` | Raw values still exist |
| TPL-37 | Undo from the toast (or restore) | Field returns to the same group and position; mapping `OK`; template `Ready` again; values rebuild with no AI call |
| TPL-38 | Delete the sequence field, restore it | Sequence setting comes back |

### Propose fields (Phase 16)

| ID | Steps | Expected |
|---|---|---|
| TPL-39 | Empty tree with a specimen | The tree points at `Propose fields` |
| TPL-40 | Open `Propose fields` | Estimate: how the page will be read (form: labelled places in reading order; table: column headers left to right), model select and `Under a minute.` — on your own key, `About $0.00x, under a minute.` and the key line. Nothing has been written |
| TPL-41 | With no provider key (Gemini, no keys) | Problem shown in place; `Propose fields` disabled |
| TPL-42 | Start it, then close the dialog while it's reading | Closing says the proposal is paid for and will resume |
| TPL-43 | Reopen the dialog on the same page | Resumes the same proposal. psql: only one new `FieldProposal` row |
| TPL-44 | Proposal list (fake: 12 fields on a form) | Paper order, label in its script, English meaning, type badge, choices/notes. All ticked except labels already in the tree (`Already in the tree`). `Choose all` / `Choose none`, a live `N of 12 fields chosen`, the amber "confidently wrong" line |
| TPL-45 | Untick one, `Add 11 fields` | Counted confirmation: **Adds 11 fields**, where they land, 1 left out, the list. Escape is blocked while saving |
| TPL-46 | Confirm | Exactly 11 fields at the end of the tree, in paper order, mode Extract, no groups. The unticked one is not created |
| TPL-47 | Propose again on the same page | Fields already added start unticked |
| TPL-48 | `Read again` | Back to the estimate; a fresh proposal costs again |
| TPL-49 | Same page in a **Table** template | 6 column proposals (fake). Visibly different from the form's list |
| TPL-50 | psql: `SELECT "promptVersion" FROM "FieldProposal" ORDER BY "createdAt" DESC LIMIT 1` | `template-v1` |
| TPL-51 | **[Gemini]** Propose on `burmese-card.jpg` as a Form and as a Table | Labels verbatim in Burmese script with English meanings; the kinds give different lists on a page with blanks above a grid |

### Duplicate and delete

| ID | Steps | Expected |
|---|---|---|
| TPL-52 | Duplicate into `This book` with `Copy mappings to output columns too` | Copy has every field, group and setting, plus mappings |
| TPL-53 | Duplicate a 20-field template with nested + selection groups into **another book** | Dialog counts what travels ("Copies 20 fields and 5 groups (2 selection groups)… as a draft in Q2") and what stays ("7 mappings stay here…"). Confirming opens the copy in the target book as `Draft` |
| TPL-54 | In the target book, Mapping → `Create columns from this template` | One click completes it. Proposal is empty afterwards |
| TPL-55 | psql: count `"Mapping"` rows for the copied template before TPL-54 | Zero |
| TPL-56 | Delete a template with documents | Counted confirmation (templates, documents, photos, rows, edited cells). Template and its documents are soft-deleted |

---

## 8. Mapping and output columns

Use a template with fields and one extracted specimen or document, so the preview has values.

### Create columns and the preview

| ID | Steps | Expected |
|---|---|---|
| MAP-01 | Mapping with nothing extracted | Preview empty state names the working order and offers `Try one document` |
| MAP-02 | `Create columns from this template` | Counted confirmation `Creates N columns and N mappings` listing each column. A `One of` group proposes **one** list column; its tick fields aren't proposed separately |
| MAP-03 | Confirm, then press it again | `Created N columns…`; the second press creates nothing |
| MAP-04 | Page layout | Left: `Filled by this template (N)`, `Not filled by this template` (each with `Map`), unused fields. Right: the preview |

### Mapping kinds

For each, open the editor, watch the preview update (≈400 ms after typing, with the edited column highlighted), save,
and check the Result Table after the rebuild.

| ID | Kind | Steps | Expected |
|---|---|---|---|
| MAP-05 | Copy | Field → column | Value copied |
| MAP-06 | Join | Two fields, separator ` / `, reorder with up/down | Joined in order; empty inputs left out |
| MAP-07 | Split, separator | Field `Mg Mg, Yangon`, separator `,`, part 2 | `Yangon` (editor is 1-based) |
| MAP-08 | Split, pattern | Pattern `(\d+)` | First capture group. Pattern without a group, or `(\d+)+`, is refused at save |
| MAP-09 | Fixed value | `2026-Q1` | Every row has it |
| MAP-10 | Expression | `{Name} + " (" + {Village} + ")"`, using `Insert a field` | Evaluates. Two digit fields joined with `+` concatenate, not sum; `number({A}) + number({B})` sums |
| MAP-11 | Expression, invalid | `{Name}.length`, `a ? b : c`, `unknownFn(1)` | Each refused at save with a plain message |
| MAP-12 | Tick group | Map `Sex` (One of): M → `1`, F → `2`, nothing ticked → `Not tested` | Values follow the options; unticked → `Not tested` |
| MAP-13 | Duplicate target | Map a second input to a column already mapped in this template | Refused |
| MAP-14 | Fill down (tables) | Toggle "Fill in ditto marks from the row above" off | Ditto cells go empty with a warning instead of inherited |

### Rebuilds and deletion

| ID | Steps | Expected |
|---|---|---|
| MAP-15 | Save any mapping | Rebuild bar `Rebuilding rows… n of N documents`, then done. No AI cost (no new `ExtractionRun`) |
| MAP-16 | `Rebuild rows` | Runs on demand |
| MAP-17 | Delete a mapping whose column has edited cells | Counted: cells that empty, edited cells kept. After confirm, edited cells keep their value **[CRITICAL]** |
| MAP-18 | Open the same mapping delete in two tabs; delete in one, then confirm in the other | Second refused with a conflict, not a silent double-delete |

### Output column editor (`Edit output columns`, from Mapping and from the Result Table)

| ID | Steps | Expected |
|---|---|---|
| COL-01 | Rename a column and reorder | `SAFE`: applies with a toast |
| COL-02 | Add a column | `ADDITIVE`: applies with a notice naming templates that could fill it. Header carries a `Not filled` chip until one does |
| COL-03 | Delete a column that has edited cells | `DESTRUCTIVE` screen: broken mappings, cleared columns, affected cells, and "38 of the 412 affected cells have been edited by you". Confirm disabled until the impact loads |
| COL-04 | Change a column type Text → Number | Destructive (type change other than to Text) |
| COL-05 | Change Number → Text | Safe |
| COL-06 | Remove one value from an Enum column | Destructive; adding one is safe |
| COL-07 | Open the editor in two tabs; apply in one, apply in the other | Second gets a conflict and must re-preview |
| COL-08 | Delete a column, then add a new one with the same key | Allowed (old key freed) |

---

## 9. Documents and photos

### Batch upload

| ID | Steps | Expected |
|---|---|---|
| DOC-01 | Documents → `Upload documents` with several templates and no filter | Must choose a template before the drop zone unlocks. With a template filter or only one template, it is pre-selected |
| DOC-02 | Drop `form.jpg`, `photo.png`, `photo.webp`, `phone.heic` | Progress per file; each becomes its own document labelled by filename. HEIC displays correctly and upright |
| DOC-03 | Drop `three-pages.pdf` | One document with 3 pages in order |
| DOC-04 | Drop `notes.txt`, `anim.gif`, `big.jpg` | Each refused with a plain reason (type / over 25 MB); others unaffected |
| DOC-05 | Template select after adding files | Locked |
| DOC-06 | Select two single-page documents → `Group into one document` | One document, pages in selected order; the emptied document disappears |
| DOC-07 | Drag pages to reorder inside the grouped document | Order saved |
| DOC-08 | `Split into single pages` | Back to one document per page |
| DOC-09 | Delete a page, then the last page of a document | Counted confirmations; deleting the only page deletes the document |
| DOC-10 | Close the dialog (X / Escape / backdrop) mid-upload | "Stop uploading? N files haven't finished". Stopping aborts those; finished ones stay as documents |
| DOC-11 | `Done` after every upload finishes | Closes with **no** "Stop uploading?" question; the list reloads and shows the new documents |
| DOC-12 | Small / medium photo size toggle | Works |

### Documents list, filters and sort (Phase 18)

| ID | Steps | Expected |
|---|---|---|
| DOC-13 | Columns | Checkbox, thumbnail, label, template, pages, run state, content state, rows, unreviewed, errors, last run, model, uploaded |
| DOC-14 | Search by part of a label | Filters |
| DOC-15 | Status select | 14 named states in 4 groups: Reading (`Not read yet`, `Waiting to be read`, `Being read`, `Read`, `Partly read`, `Reading failed`), Review (`Not fully reviewed`, `Fully reviewed`, `Flagged for a closer look`, `Not flagged`), Edits, Page changes. Each narrows correctly |
| DOC-16 | `Uploaded` | Lists days with counts (`Uploaded 2026-09-21 · 60 documents`), in **your** time zone |
| DOC-17 | Set the machine's time zone to `Asia/Yangon`, upload at 05:00 local; filter by today | Document is under today (local), not yesterday (UTC) |
| DOC-18 | Sort `Newest upload first` / `Oldest upload first` / `Book order` | Orders correctly. With >100 documents, scroll through page boundaries: no rows skipped or repeated |
| DOC-19 | With only a template filter and a sort | `Extract all in <template>` still shows (a sort is not a filter) |
| DOC-20 | Filters that match nothing → `Clear filters` | Clears everything, including Status and Uploaded |
| DOC-21 | Old bookmark `…/documents?needsReextraction=true` | Lands on the matching Status (`Page changes`) |

### Document drawer

| ID | Steps | Expected |
|---|---|---|
| DOC-22 | Click a row | Drawer: label (editable), page strip with per-page status/size/actions, Manual field inputs, run history, `Extract` / `Re-extract` |
| DOC-23 | Add a Manual field to the template, then type its value in the drawer | Saved exactly as typed; the Result Table shows it with the human tint; the row rebuilds without AI |
| DOC-24 | Open any document's drawer | No `Specimen` chip or `Use as a real document`: specimens never reach this workspace (TPL-61 adds one as a copy) |
| DOC-25 | `Add to documents` a specimen whose value duplicates an existing value in a `UNIQUE` column | The duplicate is flagged once the copy's rows are built |

### Photo editor

| ID | Steps | Expected |
|---|---|---|
| DOC-26 | Open `crooked.jpg` in the editor → `Auto-detect` deskew | A suggested angle and grid overlay |
| DOC-27 | Crop (drag; arrow keys move, Shift+arrows resize), rotate 90° | Turning by 90° clears the crop |
| DOC-28 | Save | Card shows `Edited (updating…)` until the thumbnail renders. The saved result matches the preview |
| DOC-29 | psql: `"Photo"."originalKey"` object in MinIO (console `localhost:9003`) | Original unchanged; only `transform` JSON changed |
| DOC-30 | `Reset` | Back to the original |

### Re-shooting pages (Phase 11)

Needs an extracted document with some edited and reviewed cells.

| ID | Steps | Expected |
|---|---|---|
| DOC-31 | Save a transform on an extracted page | Document gets `changed since last read` chip; Status `Page changes` finds it |
| DOC-32 | `Replace` on a page | Before the picker unlocks: "Its 12 rows and 4 cells you edited are kept, and so are your reviewed marks" |
| DOC-33 | Replace with a JPEG | Same page index. Rows, edits and reviewed marks untouched **[CRITICAL]**. Chip `changed since last read` |
| DOC-34 | Replace with a PDF | Refused (use Upload documents) |
| DOC-35 | `Add page` with a PDF | Pages appended in order |
| DOC-36 | Try delete / reorder / group / split on an extracted document | Refused plainly |
| DOC-37 | Try Replace / Add page while the document is being read (`AI_FAKE_BEHAVIOUR=slow`) | Refused with a conflict |
| DOC-38 | Re-extract the replaced document | Chip clears. Edited cells keep your values **[CRITICAL]** |
| DOC-39 | Make a re-extraction fail (`AI_FAKE_BEHAVIOUR=error`) | Chip does **not** clear |

### Move and delete

| ID | Steps | Expected |
|---|---|---|
| DOC-40 | Select extracted documents with edits → `Move to template` | Impact names the target and counts raw values, rows, cells, edited and reviewed cells and Manual values that will be discarded. Hard warning when edits exist |
| DOC-41 | Confirm | Documents land `Not read yet` on the target; photos and page order kept; rows gone; run history kept |
| DOC-42 | Move a document that is being read | Refused |
| DOC-43 | Delete 3 documents | Counted confirmation (documents, photos, rows, edited cells); soft delete |

---

## 10. Extraction

### The Extract dialog

| ID | Steps | Expected |
|---|---|---|
| EXT-01 | First extraction of a new book | Dialog states "On handwriting like this, expect to correct roughly half the cells…" |
| EXT-02 | After the book's first completed run, open it again | That line is gone |
| EXT-03 | Template with no mappings | Warning (not a blocker): "…has no mappings yet, so no rows will appear until you add them…" |
| EXT-04 | Conflicted template, or documents flagged as possible mismatch | Warnings shown |
| EXT-05 | Estimate line | "N documents · N pages · N requests to the model. About 2 minutes." No money and no key line on the server's key. With your own key saved (ACC-02): "About $0.05, about 2 minutes.", below a cent "less than $0.01", and a second line naming the key |
| EXT-06 | Include a document whose pages are still processing, a failed page, a form with >8 pages | Listed as blockers with reasons and skipped; the rest can still run |
| EXT-07 | Include documents that have edited cells or changed pages | Counts stated; edited cells will be kept |
| EXT-08 | `AI_PROVIDER=gemini` with no server key and no user key | Dialog says AI reading isn't set up and disables Extract |
| EXT-09 | Select 2 documents → `Extract`, then **double-click** Extract fast | psql (Appendix A.3): one set of runs, not two. Button disables while starting |
| EXT-10 | Template filter only, nothing selected → `Extract all in <template>` | Covers every live document of the template, not just the loaded page. Specimens are excluded |

### Progress, run drawer and failures (Phase 18)

| ID | Steps | Expected |
|---|---|---|
| EXT-11 | Extract a 3-page document and watch the list | `Running 1/3`… then `Read`. List polls every 2 s only while something is running (Network tab goes quiet after) |
| EXT-12 | `Runs` in the Documents header | Reads `Runs · reading` with a pulse while running. Drawer lists being read → failed → read in the last day; each page a numbered square |
| EXT-13 | Click a row's `Running 3/12` | Drawer opens with that document first and outlined |
| EXT-14 | Restart the worker with `AI_FAKE_BEHAVIOUR=error`, extract | Pages fail with the worker's plain reason; `extraction failed, retry in runs` chip on the row |
| EXT-15 | Restart with `ok`, `Retry page` on one page, then `Retry N failed pages` | Only failed pages re-run; list and nav refresh |
| EXT-16 | `AI_FAKE_BEHAVIOUR=rate-limited` | Surfaced clearly as rate limited, not a generic failure; the queue pauses about a minute and retries |
| EXT-17 | Extract `blank.png` | Content state `EMPTY`, 0 rows, **not** a failure; the drawer explains a blank page |
| EXT-18 | Cancel | Not offered (not built) |

### Worker crash recovery

| ID | Steps | Expected |
|---|---|---|
| EXT-19 | Worker with `AI_FAKE_BEHAVIOUR=slow`. Start an extraction, `kill -9` the worker while `Running`. Start the worker again with `ok` | Within about 3 minutes the reaper re-queues the run and the document finishes `Read` |
| EXT-20 | Stop the worker, start an extraction, wait over a minute with Documents open, start the worker | Runs left `QUEUED` are re-enqueued and complete |
| EXT-21 | Stop the worker, upload a photo, start it later | Photo processing completes (re-enqueued when polled) |

### Re-extraction never overwrites edits [CRITICAL]

1. Extract a document. In the Result Table, edit cell A to `EDITED-A` and mark cell B reviewed without editing it.
2. psql: note A's `currentValue`, `extractedValue`, `isEdited`.
3. Re-extract the document (fake answers the same values).
4. **Expected:** A still shows `EDITED-A`; `isEdited = true`; no disagreement (the reading didn't change). B stays reviewed.
5. Now make the reading differ: rename the field that feeds A (the fake echoes the label, e.g. `Name` → `Name2`),
   save, re-extract.
6. **Expected:** A still shows `EDITED-A`; `extractedValue` is the new reading; `disagreement = true`; the cell shows
   the purple bar and a chevron. If A was reviewed, it is now **un**-reviewed.
7. Chevron → `Keep mine`: disagreement clears, value stays. Re-extract again with the same reading: disagreement
   does not come back.
8. Repeat step 5, chevron → `Use extracted`: value becomes the reading.

| ID | Case |
|---|---|
| EXT-22 | Steps 1–4 |
| EXT-23 | Steps 5–6 |
| EXT-24 | Step 7 |
| EXT-25 | Step 8 |

### Raw values are stored verbatim [CRITICAL] [Gemini]

| ID | Steps | Expected |
|---|---|---|
| EXT-26 | Extract `burmese-card.jpg` with Burmese digits and a date, with Gemini | psql (Appendix A.4): `RawValue.valueText` holds Burmese digits `၁၂၃` exactly as written. The Result Table shows Latin digits after transform |
| EXT-27 | Register with a ditto mark | Raw value is the literal token (`"`, `〃`, `do.`), `isDitto = true`. Table cell shows the value from above with `⇡` and inherited tint |
| EXT-28 | Register with a total row | Row is void (`Total, void`), not counted |
| EXT-29 | Template with anchors that don't appear on the page | Document flagged `possible template mismatch` |
| EXT-30 | psql: `SELECT "promptVersion" FROM "ExtractionRun" ORDER BY "createdAt" DESC LIMIT 1` | `v1` (or the current version) on every run |

---

## 11. Result Table

Use the Demo account for most of this section.

### Loading and states

| ID | Steps | Expected |
|---|---|---|
| TBL-01 | Book with no columns | Empty state with `Edit output table`, not a pointer to Settings |
| TBL-02 | Book with columns but no rows | Empty state explaining the next step, with `Edit output table` |
| TBL-03 | Open Demo | Readout `N cells · N unreviewed · N errors`; background `Loading rows… x of y` on big books |
| TBL-04 | Legend (`?`) | Every state with one line, in channel order: authorship, semantics, attention, progress |
| TBL-05 | Find each state in the table | Edited/manual: faint blue tint. Inherited: `⇡` + neutral tint. Skip-sourced empty: hatch. `–` for dash, `n/a` small caps, `?` chip with "Could not be read" tooltip. Low confidence: dotted underline (disappears once edited or reviewed). Error: red left bar; disagreement: purple bar + chevron; warning: amber bar. Reviewed: corner dot. **Never more than one bar per cell** |
| TBL-06 | Hover a bar | Tooltip with the specific message; a cell with error and disagreement mentions both |
| TBL-07 | Header | Label, required mark, type, error count, unreviewed count; `Not filled` on unmapped columns |
| TBL-08 | Row height toggle | Compact 28 / default 32 / comfortable 40. Digits line up (tabular numerals). Burmese renders in Noto Sans Myanmar and isn't clipped |

### Editing

| ID | Steps | Expected |
|---|---|---|
| TBL-09 | Click a cell and type; Enter | Saves (≈400 ms debounce), moves down. Cell gets human tint |
| TBL-10 | F2 / double-click / Enter edit; Tab saves and moves right | As described |
| TBL-11 | Type a value, Escape | Cancels, and takes back what that session already saved |
| TBL-12 | Delete on a focused cell | Clears it |
| TBL-13 | ⌘Z / Ctrl+Z | Undoes the last editing session or revert, one at a time |
| TBL-14 | Edit a cell, then stop the app server and edit another | Toast about the failed save; the cell shows the server value again |
| TBL-15 | Arrow keys, Page Up/Down, Home/End | Move focus; Tab leaves the grid |
| TBL-16 | psql: after TBL-09 | A `CellEdit` row exists; `Cell.isEdited = true` |

### Rows

| ID | Steps | Expected |
|---|---|---|
| TBL-17 | Drag a row by its handle; reload | Order kept; export uses it |
| TBL-18 | Sort a column, try to drag | Dragging is off while sorted. Sort writes nothing (reload → manual order) |
| TBL-19 | Hover a row → provenance chip | Template name + thumbnail; click opens the photo zoomed to the record's box, with `Show whole page` |
| TBL-20 | Row menu (and right-click): Mark reviewed / not reviewed | Dots appear/disappear across the row |
| TBL-21 | `Revert row to extracted…` on a row with edits | Counted confirmation (edited cells, disagreements). After it, extracted values are back; ⌘Z undoes it |
| TBL-22 | `Mark void` / `Not void` | Row labelled void, excluded from counts; hidden unless `Show void rows` |
| TBL-23 | `Delete row…` | Counted; the confirmation says re-extraction won't bring it back |
| TBL-24 | `Review this row` / toolbar `Review rows` | Opens row review at that row |

### Filters

| ID | Steps | Expected |
|---|---|---|
| TBL-25 | Toolbar: Needs attention, Has errors, Edited, template, Show void rows, Clear filters | Each narrows correctly; Clear resets |
| TBL-26 | Column menu filters: Needs attention, Errors, Warnings, Edited, Not reviewed, Empty, Containing… | Each narrows that column |
| TBL-27 | `Refresh` | Reloads rows |

### Era and numeral offer (Phase 14)

| ID | Steps | Expected |
|---|---|---|
| TBL-28 | Create a Date column fed by values like `12.3.2569` (BE). Extract/rebuild | Header shows `N not parsing`. Column menu opens with "N dates aren't parsing in this column" and `Buddhist era (BE)` / `Myanmar calendar` |
| TBL-29 | Accept `Buddhist era` | Rows rebuild (no AI). Then `N values now parse`, or plainly that the rebuild finished and values are still wrong |
| TBL-30 | Edit one of those cells yourself to a bad date | Your edit doesn't count toward `not parsing` |
| TBL-31 | Number column with unparseable digits | Offer asks about Burmese digits instead |

### Validation rules (Settings)

| ID | Steps | Expected |
|---|---|---|
| RULE-01 | Settings → Validation rules → add | Offers `Required`, `Range`, `Unique`; `Advanced` reveals Length, Regex, Enum, Cross-column, Increasing |
| RULE-02 | Range on `Age (months)` 0–120, severity Error | Live count of failing cells while editing; after saving the cells show red bars |
| RULE-03 | Range on a Text column; min above max | Refused with plain messages |
| RULE-04 | Regex `(a)\1` | Refused (RE2 can't compile) with a plain message |
| RULE-05 | Unique on `Name` | Duplicates flagged across rows |
| RULE-06 | Cross-column comparing a column with itself | Refused |
| RULE-07 | An existing Regex rule | Opens with Advanced already expanded; still edits |
| RULE-08 | Warning severity | Amber bar; export not blocked |
| RULE-09 | Delete a rule | Flags go away |
| RULE-10 | `Re-check all cells` | Runs and reports |

### Glossary (Settings)

| ID | Steps | Expected |
|---|---|---|
| GLOS-01 | Add `ဒီ` → "ditto: same as the row above"; edit; delete | Works; order kept |
| GLOS-02 | Settings contents | Only Glossary, Validation rules and Danger zone |

---

## 12. Export

| ID | Steps | Expected |
|---|---|---|
| EXP-01 | `Export CSV` in a book with no rows | Disabled |
| EXP-02 | Open the dialog on Demo | `N rows × M columns`; "Not finished: X of Y cells not reviewed · N cells with errors · N with warnings. You can still export." Never blocked |
| EXP-03 | Export defaults | File starts with a BOM (`xxd file.csv | head -1` shows `efbb bf`), header of column **keys**, CRLF line endings, rows in manual (dragged) order |
| EXP-04 | Open the CSV in Excel (Mac and Windows) and Google Sheets | Burmese text displays correctly, not mojibake |
| EXP-05 | Blank token `-`, illegible token `ILLEGIBLE`, export | Empty cells → `-`, illegible → `ILLEGIBLE`; dash → `-`, n/a → `N/A` |
| EXP-06 | Open the dialog again | Tokens remembered from last time (written back to the book) |
| EXP-07 | Include void rows | Void rows present with a `_void` column (`yes`/`no`) |
| EXP-08 | Include provenance | `_document`, `_template`, `_photo`, `_model`, `_reviewed`, `_confidence` columns |
| EXP-09 | Choose a column subset | Only those columns, still in book order |
| EXP-10 | Values with commas, quotes and line breaks | Quoted correctly (RFC 4180); reopen shows the original values |
| EXP-11 | Specimen, tested but not added to the documents | Its rows are not in the export; a copy added with `Add to documents` is |
| EXP-12 | Copy the download URL; open it 6 minutes later | Refused (links last 5 minutes), plain-text error |
| EXP-13 | Open a fresh download URL as U2 | Refused |

---

## 13. Review

### Row review

Use Demo at 1280 and at 1600.

| ID | Steps | Expected |
|---|---|---|
| REV-01 | Open Review | Photo runs the full height; header (position, progress, save state, `Pace`, `Next unreviewed`) at the top of the values pane. Row boxed dashed, active cell boxed solid and kept centred |
| REV-02 | Header text | `Document x of y · Row a of b`; `N of M cells reviewed · x of y documents complete` |
| REV-03 | Enter | Marks the cell reviewed (dot), moves to the next |
| REV-04 | Tab / Shift+Tab, ↑/↓ | Move across cells and row ends |
| REV-05 | ⌘Enter / Ctrl+Enter | Marks the row reviewed, opens the next row |
| REV-06 | `I` | Marks unreadable and reviewed, moves on |
| REV-07 | Edit a value, then `R` | Reverts to extracted |
| REV-08 | `[` / `]` | First row of the previous / next document |
| REV-09 | `N` | Next unreviewed |
| REV-10 | Hold Space | Photo zooms to the active cell; releasing restores |
| REV-11 | `Show whole page` | Whole page shown |
| REV-12 | F2, type a value starting with `i`, Enter | Value typed (letter keys act only outside the editor); saved, marked reviewed, moves on |
| REV-13 | While typing: Tab saves and moves; ⌘Enter saves and marks the row; Esc cancels and takes back that session's saves | As described |
| REV-14 | Delete clears; ⌘Z undoes | As described |
| REV-15 | Type fast and reload immediately | Browser asks before leaving while saves are in flight |
| REV-16 | Esc (not editing) | Back to the table |
| REV-17 | Review reaches the last cell | `Every cell is reviewed` with Export; if any are left, the count with `Next unreviewed` |
| REV-18 | Void rows | Skipped |
| REV-19 | Low-confidence cell | Shows `uncertain · 41%`; edited or disagreeing cells show the extracted value too |

### Resume (Phase 19)

| ID | Steps | Expected |
|---|---|---|
| REV-20 | Review a few cells in document 3, go to Templates, then click `Review N left` | Resumes in document 3: `Resuming in <document>, where review stopped.` |
| REV-21 | Leave the book; open it again from the books list (not onto Review) | Toast `You stopped partway through review.` with `Resume review` → lands in that document |
| REV-22 | Repeat REV-21 in another browser signed in as the same user | Same document (derived from data, not local storage) |
| REV-23 | Book with nothing reviewed | No resume toast |
| REV-24 | `?row=<id>` in the URL | Wins over resume |

### Glossary from review (Phase 19)

| ID | Steps | Expected |
|---|---|---|
| REV-25 | On a ditto cell press `G` | `Add to glossary` dialog prefilled with what was **written** (`ဒီ` / `"`), not the resolved value |
| REV-26 | Drag-select part of the active value | `Add "…" to glossary` appears beside it; only the part inside the value is kept |
| REV-27 | Click once on the active value and release without selecting | Opens the editor as before |
| REV-28 | Add an entry | "Added "…" to the glossary. The next extraction will use it." Entry shows in Settings → Glossary |

### Pace (Phase 19)

| ID | Steps | Expected |
|---|---|---|
| REV-29 | Review ~10 cells with Enter every 2 s, then ⌘Enter a row, then `I` a few cells. Open `Pace` | Three lines: `Cell by cell (Enter)`, `Whole rows (⌘Enter)`, `Unreadable (I)`, never blended. Enter line ≈2 s per cell; the row mark's time is spread over its cells |
| REV-30 | Wait over 5 minutes, review one cell, reopen Pace | That cell is counted but not timed (a break) |
| REV-31 | Brand-new book's first review | Shows as `not timed · 1 cell` |

### Column sweep (Phase 20)

| ID | Steps | Expected |
|---|---|---|
| SWP-01 | Result Table → a column header menu → `Sweep this column · N unreviewed` | Sweep opens; nav's `Review` stays lit; URL `/review/sweep?column=…` |
| SWP-02 | Each row | The value beside its own crop from its own page (≤96 px high). A value with no region of its own shows the row's box and says so; none at all says `No region recorded for this value.` |
| SWP-03 | Page pane | Active value's page, row dashed, value solid; collapsible |
| SWP-04 | Enter, ↑/↓, Tab/Shift+Tab | Accepts and moves down / moves |
| SWP-05 | ← / → | Switches column, keeps the row |
| SWP-06 | `I`, `R`, `N`, `[` `]`, `G`, F2, Delete, ⌘Z, Space, PageUp/PageDown, Home/End, Esc | Same meanings as row review, down the column |
| SWP-07 | Finish a column | `Every value in <column> is reviewed` with `Sweep <next column with work>` |
| SWP-08 | Header | `Value n of N`, `x of y reviewed in this column · a of b cells in the book`, save state |
| SWP-09 | In row review press `S` | Sweep opens on the active column at the active row; `Review rows` returns to that row |
| SWP-10 | After sweeping, compare the nav count, the row review progress bar and Pace | All include sweep reviews; Pace counts them under `Cell by cell (Enter)` |
| SWP-11 | psql (Appendix A.5) | Swept cells have `reviewedVia = 'CELL'` (or `'ILLEGIBLE'` for `I`), same as row review |
| SWP-12 | Scroll quickly through 3,000 rows (Table demo) | Smooth; crops load after scrolling settles |

---

## 14. Phone upload (below 1280px)

At 390px in devtools, and once on a real phone against a LAN address (`AUTH_URL` and `S3_PUBLIC_ENDPOINT` must be
reachable from the phone).

| ID | Steps | Expected |
|---|---|---|
| PHN-01 | Open any book URL | Upload screen: plain line that review needs a wider screen, template select, `Take a photo` and `Choose photos or PDFs` |
| PHN-02 | Book with no templates | `No templates yet`, pointing at a computer |
| PHN-03 | Try to upload with no template chosen | "Choose a template first." |
| PHN-04 | `Take a photo` on a real phone | Opens the camera straight away |
| PHN-05 | Choose 2 photos and a PDF | One row per file: `Uploading 40%` → `Saving…` → `Processing…` → `Ready`. Template locked. Each photo is its own document, the PDF one document |
| PHN-06 | `Done` | Says how many documents went into which template and whether pages are still processing |
| PHN-07 | `Upload more` | Starts again with the same template |
| PHN-08 | Try to leave mid-upload | Browser asks first |
| PHN-09 | On a computer, open Documents | The phone's uploads are there under today's `Uploaded` day |

---

## 15. Security and isolation

Sign in as U1 in one browser and U2 in another. Copy ids from U1's URLs and network calls.

| ID | Steps | Expected |
|---|---|---|
| SEC-01 | As U2, open U1's `/books/<id>`, a template, the Mapping route, `/review`, `/review/sweep` | `Page not found` (never U1's data, never "forbidden", which would confirm it exists) |
| SEC-02 | As U2, from the devtools console, `fetch('/api/books/<U1 book>/rows')`, `/api/templates/<id>`, `/api/documents/<id>`, `/api/runs/<id>` | `NOT_FOUND` |
| SEC-03 | As U2, `PATCH /api/cells/<U1 cell id>` with a value | `NOT_FOUND`; psql shows U1's cell unchanged |
| SEC-04 | As U2, duplicate your own template with `targetBookId` = U1's book | `NOT_FOUND` |
| SEC-05 | As U2, `POST /api/books/delete` with U1's id mixed with your own | Whole request `NOT_FOUND`; neither book deleted |
| SEC-06 | Signed out, `curl` any `/api/books` endpoint | Unauthorised, not data |
| SEC-07 | As U2, open U1's export download URL | Refused |
| SEC-08 | As U2, `GET /api/photos/status?ids=<U1 photo>` | Nothing of U1's returned |
| SEC-09 | `GET /api/test/outbox?to=…` with `EMAIL_TRANSPORT=log` | 404 |
| SEC-10 | Destructive endpoint without the impact hash (e.g. `POST /api/documents/delete` with `{ids, confirm:true}`) | Refused with a validation error |
| SEC-11 | Glossary entry and field label containing `<img src=x onerror=alert(1)>` | Rendered as text everywhere (tree, table, review, glossary, export); no alert |
| SEC-12 | Upload a `.txt` renamed to `.jpg` | Worker sniffs the real type and fails the photo plainly |

---

## 16. Resilience, operations and performance

| ID | Steps | Expected |
|---|---|---|
| RES-01 | Stop Redis. Edit a cell, rename a field, save a mapping | Edits save. A rebuild can't be queued but the save itself doesn't fail or hang more than ~5 s. Log shows `rate limit check skipped` for rate-limited endpoints |
| RES-02 | Start Redis; Mapping → `Rebuild rows` | Rebuild runs and the table catches up |
| RES-03 | Stop MinIO, open Documents | Thumbnails fail to load; page still works; plain errors, no crash |
| RES-04 | Trigger an error page; copy its `Reference` | The same reference appears on an error line in the app log |
| RES-05 | Take `X-Request-Id` from an Extract start request | Found as `requestId` in the app log and `correlationId` in the worker log |
| RES-06 | `pnpm storage:cleanup --dry-run` | Reports what would be purged, deleted, swept and stripped; deletes nothing |
| RES-07 | Delete a document, then `pnpm storage:cleanup --dry-run --now=<today + 31 days ISO>` | Its photos are counted for purge |
| RES-08 | Backup rehearsal (docs/09 §3) on a copy | Restored database has identical counts; health checks pass; photos load |
| PERF-01 | Table demo (3,000 rows): open the Result Table | All rows load in the background; scrolling stays smooth; typing in a cell doesn't lag |
| PERF-02 | Sort and filter on 3,000 rows | Responsive |
| PERF-03 | Documents list with a few hundred documents | Virtualised, smooth |
| PERF-04 | Upload 60 photos in one batch | All finish; UI stays responsive |

### Accessibility

| ID | Steps | Expected |
|---|---|---|
| A11Y-01 | Every modal | Focus trapped; Escape closes, except during a destructive confirm in progress |
| A11Y-02 | Tab through sign-in, books list, templates, documents | Visible focus everywhere; everything reachable |
| A11Y-03 | Grayscale mode (devtools rendering → emulate achromatopsia) on the table | Every state still distinguishable by shape, glyph or position |
| A11Y-04 | Exactly one cell has the accent focus ring at any time | True in table, review and sweep |

---

## 17. Release path (smoke, ~30 min)

The same path as the E2E, by hand, with the fake worker. Do it in a fresh account.

1. Sign up, confirm the email from the log, sign in. (AUTH-02, AUTH-05)
2. `Create your first book` → `Smoke ledger`. Lands on Templates. (BOOK-03)
3. `Create your first template` → Form `Household card`.
4. Drop `form.jpg` into the photo pane; wait for `Propose fields` to enable. (TPL-06)
5. Add fields `Name` and `Village`. (TPL-13)
6. Mapping → `Create columns from this template` → `Create 2 columns`. `Filled by this template (2)`. (MAP-02)
7. Back to Fields → `Test on this page` → `Name 1` appears beside the photo.
8. Templates: `0 documents`, `1 specimen`. Result Table: no rows. (TPL-12)
9. Fields → `Add to documents` → `Nothing is read again` → confirm. Documents lists the copy; the specimen stays. (TPL-61)
10. Result Table shows `Name 1`, `Village 1`.
11. `Village` header → `Sweep this column` → Enter → `Every value in Village is reviewed`. (SWP-01, SWP-07)
12. `Review rows` → `G` → add a glossary meaning → toast. (REV-28)
13. Ctrl+Enter → `Every cell is reviewed`. `Pace` shows `Cell by cell (Enter)` and `Whole rows (⌘Enter)`. (REV-05, REV-29)
14. Export → `Export 1 row`. File has a BOM, header `name,village`, row `Name 1,Village 1`. (EXP-03)
15. Edit `Name 1` to `Mg Mg` in the table, re-extract the document, confirm `Mg Mg` survives. (EXT-22)
16. Sign out through the confirmation modal. (AUTH-26)

---

## Appendix A — SQL checks

Replace `<…>` placeholders. All ids are cuid2 strings.

**A.1 Find ids by name**
```sql
SELECT b.id AS book, t.id AS template, t.name FROM "Book" b JOIN "Template" t ON t."bookId" = b.id
WHERE b.name = 'Smoke ledger' AND b."deletedAt" IS NULL;
```

**A.2 A cell's full state** (rule 1)
```sql
SELECT c.id, oc.label, c."currentValue", c."extractedValue", c."isEdited", c.disagreement,
       c."isReviewed", c."reviewedVia", c."validationState"
FROM "Cell" c JOIN "OutputColumn" oc ON oc.id = c."outputColumnId"
JOIN "Row" r ON r.id = c."rowId"
WHERE r."documentId" = '<document id>' AND r."deletedAt" IS NULL
ORDER BY r.position, oc.position;
```

**A.3 Runs per document** (idempotency, EXT-09)
```sql
SELECT "documentId", count(*), array_agg(state) FROM "ExtractionRun"
WHERE "documentId" IN ('<doc1>', '<doc2>') GROUP BY "documentId";
```

**A.4 Raw values as read** (rule 2)
```sql
SELECT f."labelSource", v."valueText", v."altValueText", v.state, v."isDitto", v.confidence
FROM "RawValue" v JOIN "Field" f ON f.id = v."fieldId"
JOIN "RawRecord" rr ON rr.id = v."rawRecordId"
WHERE rr."documentId" = '<document id>'
ORDER BY rr."recordIndex";
```

**A.5 How cells were reviewed**
```sql
SELECT c."reviewedVia", count(*) FROM "Cell" c JOIN "Row" r ON r.id = c."rowId"
WHERE r."bookId" = '<book id>' AND c."isReviewed" GROUP BY 1;
```

**A.6 Soft-deleted things**
```sql
SELECT 'book' AS kind, id, "deletedAt" FROM "Book" WHERE "deletedAt" IS NOT NULL
UNION ALL SELECT 'document', id, "deletedAt" FROM "Document" WHERE "deletedAt" IS NOT NULL
ORDER BY 3 DESC LIMIT 20;
```

**A.7 Edit log for a cell**
```sql
SELECT * FROM "CellEdit" WHERE "cellId" = '<cell id>' ORDER BY "createdAt";
```

## Appendix B — Resetting

- Re-run `pnpm db:seed-demo` / `pnpm db:seed-table` to restore those accounts.
- Wipe everything: `docker compose down -v`, then `docker compose up -d postgres redis minio minio-init` and
  `pnpm db:migrate`.
- Worker behaviour: stop it, change `AI_FAKE_BEHAVIOUR`, start it again.
