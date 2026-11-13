# Agent brief — dashboard

Factual snapshot of this repository for a coding agent starting with no context.
`AGENTS.md` holds the mission and the working principles (intent); this file says
what actually exists, how it is verified and where the traps are. Snapshot:
2026-10-05.

## What it is

A single-owner personal steering dashboard: personal budget, real-estate assets,
GitHub/GitLab project activity and a home dashboard. Interface in French, code and
comments in English. No public sign-up, no multi-tenancy. Provider access is
read-only; personal and company data are not mixed.

## Stack

- Next.js 16.3.7 (App Router, Turbopack, `src/` directory), React 19.2.8, TypeScript 5
- Tailwind CSS 4, ESLint 9 (flat config)
- Prisma 7.10 with the `@prisma/adapter-pg` driver adapter, PostgreSQL 18
- Auth.js v5 beta: credentials provider, bcryptjs, JWT sessions
- zod 4, decimal.js, react-hook-form + @hookform/resolvers
- Vitest 5; npm; Docker Compose; GitHub Actions (`.github/workflows/ci.yml`)
- Node.js 22 or later

## Layout

```text
src/
  app/(app)/         authenticated pages: account, alerts, budget (incl. /budget/import), dashboard, integrations, micro-business, real-estate
  app/api/           Route Handlers: auth callbacks + CSV export (401 JSON, never a redirect)
  app/login/         sign-in page
  components/        shared UI (forms, server-rendered SVG charts, navigation)
  modules/           business rules per module: identity, budget, real-estate,
                     micro-business, integrations, alerts, dashboard, audit, catalog
                     (domain.ts / repository.ts inside each)
  lib/               db, env, money, dates, csv, crypto, auth helpers
  jobs/sync.ts       idempotent synchronisation functions (no scheduler shipped)
  generated/prisma/  generated client — git-ignored; run `npm run db:generate`
prisma/              schema, migrations, seed
infra/               backup / restore scripts, Caddyfile for the proxy
docs/                architecture/overview.md, decisions/
```

## Data model (`prisma/schema.prisma`)

`User` (sole owner) owns `Account`, `Category`, `Transaction`, `Budget`,
`RecurringEntry`, `Goal`, `SalarySetting`, `SalaryRate`, `WorkDay`, `Property`,
`Client`, `Project`, `IntegrationConnection`, `Alert`, `AlertRule`. Key rules:

- `Transaction.amount` is `Decimal(18, 2)`, signed (negative = outflow); never floats.
- `Transaction.operationDate` is `DATE`; instants are `timestamptz(3)` UTC.
- `Transaction.transferGroupId` links the two legs of one internal transfer (source
  negative, destination positive, written in a single database transaction, same
  currency); deleting either leg deletes the group, editing one leg alone is refused.
- `Transaction.reconciledAt` (DATE?) is the day the line was checked against a bank
  statement; empty = not checked yet (a state, not a missing value).
- `Budget.amount` is `Decimal(18, 2)` and always positive (a planned magnitude);
  one row per `(userId, categoryId, year, month, currency)` unique tuple.
- `SalarySetting` (one per owner: default hours per day, currency — global options) and
  `SalaryRate` (one per owner and month: the hourly rate as a change point, effective
  from that month until the next entry; a month before the first entry has no rate) plus
  `WorkDay` (one per owner and date: `PLANNED`/`WORKED` + hours) power the salary
  simulator; its booking button writes one INCOME transaction per month (`externalRef`
  `salary:YYYY-MM`, category « Salaire », seeded as a default category).
- `Goal` is a target amount in one currency with a target date and a status; its current
  amount comes from a linked `accountId` **or** a manual `currentAmount` (mutually
  exclusive, enforced by the action). A manual goal's progress is its starting amount
  plus the sum of its `GoalContribution` rows — dated log entries (amount, date, note),
  never ledger transactions — and missing data reads "unknown", never zero. Linking is
  owner-scoped and same-currency; linked goals take no contributions. No conversion is
  ever applied.
- `RecurringEntry.frequency` is `MONTHLY` / `QUARTERLY` / `YEARLY` (counted from the
  start month). Editing a series is allowed; moving its cadence or start date clears the
  pending occurrences so they are rebuilt, and the start date is locked once a decision
  exists.
- `Alert` stores one episode per watched condition: `fingerprint` (unique with the
  owner), `status` (ACTIVE / DISMISSED / RESOLVED), and `inputs` as `Json` — message
  inputs only, never the displayed sentence. `AlertRule` holds one configuration per
  kind (enabled, one of thresholdAmount/thresholdCurrency/thresholdPercent/thresholdDays).
  `BUDGET_THRESHOLD` is the preventive rule before `BUDGET_OVERRUN` (fires below 100 % of
  the envelope, resolves when the overrun takes over).
- `PropertyCashflow` carries **either** a typed `amount` **or** a `transactionId`
  (mutually exclusive, link unique): no double counting in property totals.
- `PropertyLoan` holds a property's financing (capital, a stored `outstandingBalance`
  snapshot with `balanceAsOf`, an optional positive rate, `termMonths`, monthly
  `paymentAmount`/`insuranceAmount`, dates), owned through its property and **never**
  fed into `computePropertyTotals`: financing is the cost of owning, not operating
  cashflow. A missing balance reads unknown, never zero.
- `CostEntry` is one canonical cost: signed `Decimal(18,2)`, currency, actuality,
  source identifiers (never a token), inclusive `periodStart`..`periodEnd`, optional
  dimensions and a `DRAFT`/`FINALIZED` status. `CostAllocation` is a child row that
  splits it across dimensions; the unallocated remainder is derived. Allocated +
  unallocated equals the total in cents; finalized entries reject every write.
- `IntegrationConnection.credentialsCiphertext` holds the AES-256-GCM token; it is
  never returned to the browser.
- `Client` / `Project` (micro-business, workspace-scoped) carry an explicit
  `billingModel` enum; `billingBehaviour` marks `FIXED_PRICE`,
  `TIME_AND_MATERIALS` and `RETAINER` as billable and `INTERNAL` / `NON_BILLABLE` as
  producing no revenue. A billable project requires a client. `archivedAt` is a
  reversible stamp: archiving writes no other column, so an archived record keeps
  everything, and names stay unique per workspace (archived rows included).
- `RevenueDocument` (invoice or explicit credit note) stores positive magnitudes, an
  optional `creditNoteForId`, and a frozen recognition snapshot (`recognizedOn` +
  `recognizedAmount`, set together or not at all). `RevenuePayment` / `RevenueRefund` /
  `RevenueWriteOff` attach positive, dated rows to an invoice. `statementOf` derives
  net issued, paid, outstanding, overdue days and a status on every read; no status
  column exists. Overpayment is refused; a credit note never exceeds the balance.
- `ProjectSnapshot` / `IssueSnapshot` / `MilestoneSnapshot` are keyed by
  `(connectionId, externalId)` — that is what makes a sync re-runnable.

## Commands

| Command | Notes |
| --- | --- |
| `npm install` | Dependencies are not committed. |
| `npm run db:generate` | Generates the Prisma client into `src/generated/prisma`; required before typecheck, tests and build. |
| `npm run dev` | Development server. If host port 3000 is taken: `env PORT=3100 npm run dev`. |
| `npm run lint` | ESLint 9. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Vitest, one run (`npm run test:watch` to keep it running). No database, no network: adapters get an injected fake `fetch`. |
| `npm run build` | Production build. It type-checks test files too. |
| `npm run db:migrate` / `npm run db:deploy` | Create + apply a migration (dev) / apply pending migrations (deploy, CI). |
| `npm run db:seed` | Creates the single owner from `SEED_OWNER_*`; idempotent. |
| `npm run db:studio` | Prisma Studio. |

Local flow: `npm install`, `npm run db:generate`, copy `.env.example` to `.env`,
`docker compose up -d --wait db`, `npm run db:migrate`, `npm run db:seed`,
`npm run dev`.

Full stack: `docker compose --profile full up -d --build` →
http://dashboard.localhost:8888 (the proxy belongs to the `full` profile).

## Environment

- Copy `.env.example` to `.env`; it documents every variable.
- Required server-side: `DATABASE_URL`, `AUTH_SECRET` (32+ characters),
  `INTEGRATION_ENCRYPTION_KEY` (32 bytes, base64, protects provider tokens),
  `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`.
- The browsed origin is three coupled variables that must agree: `AUTH_URL` (what
  the app is told), `APP_HOST` (what the proxy answers for) and `PROXY_PORT` (the
  published host port). Default: `http://dashboard.localhost:8888`.
- `SEED_OWNER_FORCE_PASSWORD=true` is the only way to put the environment password
  back in force ("forgotten password" path). Default false: a password changed
  from the Compte page survives restarts.
- `NEXT_PUBLIC_DEFAULT_CURRENCY` / `NEXT_PUBLIC_DEFAULT_TIME_ZONE` default to
  `EUR` / `Europe/Paris`; only `NEXT_PUBLIC_*` reaches the browser.
- `src/lib/env.ts` validates the server variables on first use and fails loudly.

## Architecture rules (do not break)

- Modular monolith. No microservices, no message queue, **no Python/FastAPI** —
  server code is Next.js (Route Handlers, Server Actions).
- Business rules live in `src/modules/<module>` (domain/repository), never in
  pages or handlers.
- Writes go through Server Actions: the action re-validates with the same zod
  schema as the form, and every identifier from the browser is looked up
  owner-scoped (a foreign id is simply "not found").
- Authorisation is server-side everywhere: `requireUser()` for pages,
  `requireApiUser()` → 401 JSON for API routes. `src/proxy.ts` (Next 16's
  middleware file) is a UX redirect only.
- Money: exact decimals / decimal.js, never floats; negative = outflow; a positive
  amount on an expense is a reimbursement. A transaction takes its currency from
  its account, a linked cashflow from its transaction.
- Transfers count by sign and stay a **subset** of income/expenses (never added on
  top). Indicator definitions are documented in `docs/architecture/overview.md`.
- Secrets stay server-side: tokens encrypted at rest, `.env` git-ignored, no
  personal data in fixtures/screenshots/logs.
- After a write: `revalidatePath` in the action + `router.refresh()` in the client.
- Never pass a `Decimal` or a `Date` to a client component; map records to
  strings-only DTOs (see `toTransactionFormInitialValues`).

## Implemented

- Auth + `/account`: password change with server-enforced rules (min 12 chars,
  max 72 bytes); a change signs out every session (the token carries a password
  fingerprint).
- Budget: accounts, categories, transactions (create; edit **in place** on the
  operations table — Enter saves, Escape cancels, notes stay in the full
  `?edit=<id>` form — duplicate via `?copy=<id>`, delete with a confirmation step;
  a linked-transfer leg is not editable and deletes its group), filters (account,
  category, type, text, reconciliation, and an all-months scope), sortable columns,
  pagination, monthly totals per currency; two server-rendered SVG charts (12-month
  trend, category breakdown) that always print exact figures; a period comparison
  (previous month, same month last year, per currency and per category; hidden rather
  than partial when a read is truncated); a manual CSV import page
  (`/budget/import`: parsed in the browser, dedicated Server Action with
  debit/credit pair, duplicate detection, `import:` references, 2 000-row bound);
  CSV export at `/api/export/transactions` (month, `?year=`, `?all=1`, or an explicit
  inclusive `from`/`to` window; `no-store`, formula neutralisation, bounded by
  `EXPORT_ROW_LIMIT` with `X-Export-Truncated` when the cap cuts the file, one audit entry
  per delivered file); the umbrella `/api/export?entity=...` selects the same builder;
  monthly
  budgets per category and currency (create, edit
  via `?editBudget=<id>`, delete with a confirmation step — a positive planned
  amount, duplicates rejected, currencies never converted; a "copy last month"
  button and rolling 3-month averages as display-only suggestions). The page is split into
  eight tabs selected by `?tab=` — Opérations (entry, filters, month list), Analyse
  (indicators, charts, period comparison), Budgets, Suivi (planned vs actual per category and currency,
  with per-currency totals for expenses and income under the table: operation dates
  only, refunds reduce their category, transfers and uncategorised lines excluded, no
  conversion), Prévisions (recurring series of expected income or expenses — monthly,
  quarterly or yearly: occurrences materialised idempotently; confirming creates the
  transaction through the manual path, passing or discarding writes an auditable
  decision and no transaction, nothing counts in a total before a confirmation; series
  are editable, with the start date locked once a decision exists — plus the month's
  salary prévision, computed from the simulator, shown as the first row of the
  échéances table (registration form in the row; once recorded, listed among the
  month's decisions) and recorded through the same booking as the Salaire tab, plus
  per-currency prévisionnel totals above the list, and a 6-month scheduler below it,
  computed from the calendar and completed with each month's salary — simulated from
  its clicked days, or the booked amount; a month with no clicked day shows none — and
  its per-currency simulated end-of-month balance (recorded cumulative before the
  window, advanced by recorded operations and pending movements, each counted once;
  « — » when the currency has no recorded operation), while the simulator's amounts
  stay absent from every actual total), Objectifs (savings or repayment
  targets: current amount from a linked account's recorded balance or a manual starting
  amount plus a dated contribution log, progress as amount + percentage, remaining, and a monthly contribution rounded
  half-up on cents — undefined after the deadline or once reached, and an unknown
  source always reads as "unknown", never as zero; above the table, a computed
  **savings threshold**: six months of expected expenses from the recurring series
  (current month + 5, per currency, never stored), compared to the recorded balance of
  the accounts typed SAVINGS — an unrecorded account stays unknown, and a runway in
  months is shown next to it), Salaire (hourly-rate simulator: the rate is a change
  point, set per month and effective from it until the next entry — a month with no
  rate at all keeps its calendar and booking refused;
  one click plans a day, a second marks it worked, a third clears it; a booking button
  records the month's simulated amount — planned and worked days, each once — as one
  INCOME in the default « Salaire » category) and Comptes (balances, projected
  end-of-month balance per account — recorded balance + pending occurrences, never the
  simulated salary — account rename/retype/currency-while-empty/archive/restore, and
  category rename/merge/delete with usage counts shown first) — each tab reading only
  its own data; `?edit=`/`?editBudget=`/`?editGoal=`/`?editRecurring=` links land on
  their tab.
- Real estate: properties (explicit occupancy — not all rented), cashflow entries
  (amount XOR transaction link), totals, due dates, notes. Loans (financing): create,
  edit (`?editLoan=`) and delete with a confirmation, totalled per currency and shown
  apart from the operating figures — financing never counts in the property totals.
- Micro-business (`/micro-business`, module key `micro-business`): clients and projects,
  both archived rather than deleted. A project carries an explicit billing model
  (`FIXED_PRICE`, `TIME_AND_MATERIALS`, `RETAINER`, `INTERNAL`, `NON_BILLABLE`), a status
  (`ACTIVE`/`COMPLETED`), its own currency and optional start/end dates; a billable model
  requires a client. Create/edit via `?editClient=` / `?editProject=`, archive/restore
  with one click. Only `OWNER`/`ADMIN` write; every member reads.
- Revenue (`/micro-business/revenue`): invoices and explicit credit notes, with dated
  payments, refunds and write-offs. Statuses (open, partially paid, paid, overdue,
  written off, credited) and every figure are derived on read from the stored rows;
  overpayment is refused, a credit note is the explicit correction path, and overdue
  starts the day after the due date in the owner's time zone. Recognition is a frozen
  `recognizedOn` + `recognizedAmount` snapshot (rules arrive with M15-01). The monthly
  summary omits a month without data rather than showing zeros.
- AI costs (`src/modules/ai-costs`): canonical `CostEntry` (signed exact amount,
  currency, mandatory actuality, immutable source reference, inclusive period, optional
  dimensions) and `CostAllocation` splits across project/client/repository/developer/
  agent/issue/PR/environment/tag dimensions. Allocated plus derived unallocated always
  equals the entry total in cents; weighted splits use largest remainder; a finalized
  entry and its allocations are immutable (corrections are new entries). Workspace-
  scoped; no UI, import, provider sync, exchange rate or profitability math yet.
- Integrations: read-only GitHub (projects, open issues + PRs, explorer with
  combinable filters validated against present data, an actionable work queue —
  unanswered, old PRs, no milestone/label, blocked, milestones due — computed from
  stored data only, milestones); encrypted tokens;
  manual idempotent sync (`src/jobs/sync.ts`), fetch bounded on purpose. GitLab is
  limited to project metadata by policy.
- Alerts (`/alerts`, « Alertes » in the nav): deterministic rules only (low balance,
  budget overrun, budget threshold — the preventive one, below 100 % of an envelope,
  resolved the moment the overrun takes over — unusual expense, stale integration,
  overdue cashflow), evaluated
  server-side on demand by one bounded pass that the dashboard and the alert page run
  while rendering. Alerts never write to the ledger; each row stores message **inputs**
  (strings), and the French reason is recomputed by `describeAlert`. Fingerprint
  (rule + entity + period, unique per owner) suppresses duplicates; dismissing silences
  an episode until it resolves, after which a re-trigger reopens it. Rules are
  configurable per kind (`AlertRule`, empty threshold = default; amount thresholds
  always name a currency — no conversion) and disabling one closes its open episodes.
  Missing data is never a zero: an account without transactions, a never-synced
  connection, or a truncated month read keeps the rule quiet.
- Dashboard: month totals per currency, budget tracking (planned vs actual per
  currency and kind, the remaining drives the card tone, no card when no budget
  exists), indicators from stored snapshots; distinguishes "no data" /
  "not connected" / "synchronisation failed" — never shows a misleading 0.
- Backups (`infra/backups/`) and CI (lint, typecheck, tests, `db:deploy` on a fresh
  PostgreSQL service, build).

## Not implemented (do not assume they exist)

- No scheduler/cron for sync — the function exists, only the manual trigger ships.
- The `micro-business` module has clients, projects and revenue documents only: no rate
  card, estimate/version, recurring business expense or business-to-personal transfer
  yet (M10-03 and later). Revenue records cannot be edited or deleted: a credit note,
  refund or write-off is the explicit correction path.
- Properties and cashflow entries cannot be edited or deleted from the interface yet.
  Loans (financing), accounts (rename/retype/archive/restore), categories
  (rename/merge/delete) and recurring series (edit) are managed in the interface
  (loans on `/real-estate`, the rest in the « Comptes » tab of `/budget`).
- No bank connector, no payment/accounting/tax advice, no writing to GitHub or
  GitLab, no document storage, no AI features. Out of scope by design. The CSV
  import is manual and deliberate.

## Gotchas verified in this repo

- Next 16 renamed `middleware.ts` to `src/proxy.ts`; API routes are excluded from
  its matcher so they answer 401 JSON instead of redirecting.
- Prisma 7 requires the driver adapter (`new PrismaClient({ adapter: new PrismaPg(...) })`).
- The generated client is git-ignored: run `npm run db:generate` after install.
- The Docker image uses `output: "standalone"` (no devDependencies): run the app
  with `node server.js`; the Prisma CLI lives only in the `db-tools` stage (compose
  services `migrate` and `seed`).
- `AUTH_URL` must equal the origin actually browsed or sign-in redirects to an
  unreachable container host; Caddy answers an empty 200 for an unknown `Host`
  (a blank tab means a wrong name, not a crash); `*.localhost` resolves to loopback
  with no hosts entry (RFC 6761).
- The seed keeps the stored password unless `SEED_OWNER_FORCE_PASSWORD=true`;
  changing `SEED_OWNER_EMAIL` would create a second owner — the app assumes one.
- Adding a scalar-list column (`String[]`) leaves existing rows NULL; a backfill +
  NOT NULL follow-up migration is required (see `IssueSnapshot.assignees`).
- `next build` type-checks `*.test.ts`: re-run `npm run typecheck` after editing a test.
- Use `useWatch`, never `form.watch()` (React Compiler lint rule).
- A signed JWT can outlive its `User` row; `getSessionUser()` treats a missing row
  as signed out.
- This machine: host ports 5432 and 3000 are usually taken (another project uses
  them) — use `POSTGRES_PORT=5433` and `env PORT=3100 npm run dev`; Docker Desktop
  must be running.
- PostgreSQL 18+ images need the `db-data` volume mounted at `/var/lib/postgresql`
  (data lives in `/var/lib/postgresql/18/docker`); mounting `/var/lib/postgresql/data`
  makes the entrypoint refuse to start. The pre-18 dev cluster is parked at
  `/var/lib/postgresql/pg17-retired` in the volume (see `docs/decisions/0002`).

## Verification recipes

- Never verify against real data. Use a throwaway project:
  `env POSTGRES_PORT=5544 docker compose -p smoke --profile full up -d db`, deploy +
  seed with fictitious `SEED_OWNER_*` values, dev server on 3100 with
  `AUTH_URL=http://localhost:3100` (otherwise sign-in redirects to the Docker
  origin), then `docker compose -p smoke --profile full down -v`.
- The unit suite needs no database; the reliable end-to-end check for a write flow
  is the throwaway stack above, then check the page, the totals and the export.

## Where to read more

- `README.md` — setup, proxy, scripts, environment variables, tests, production.
- `docs/architecture/overview.md` — modules, request flow, indicator definitions,
  security model, sync bounds.
- `AGENTS.md` — mission, scope, working principles, delivery expectations.
