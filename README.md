# Dashboard

Personal steering companion: GitHub/GitLab project activity, real-estate assets
and a personal budget, in a single Next.js application.

Interface in French, code and comments in English. See `AGENTS.md` for the
project intentions and `docs/architecture/overview.md` for the design.

## Status

This is a **base project**: the foundations are in place and verified, and the
first functional slice (data entry, budget view, real-estate view, CSV export,
provider adapters) is implemented.

Working today:

- Owner authentication (Auth.js credentials, no public sign-up), with a **Compte**
  page to change the owner password.
- Workspace roles (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`) enforced server-side: a
  viewer can read but cannot write or export, an admin can manage members and modules
  but can never remove or demote the owner.
- Personal budget: accounts, categories, transactions entered from the budget
  page, monthly totals per currency, filters, CSV export, deletion with confirmation,
  correction of an existing operation and two charts (a 12-month trend and the month's
  spending per category). The month's list is a small spreadsheet: rows are editable in
  place (Enter saves, Escape cancels; notes stay in the full form), columns sort, pages
  are counted rather than the list silently cut, a « Pointer » tick records the day a
  line was checked against a bank statement (with its own filter), an operation can be
  duplicated into a fresh form, and a text search can widen to every month. A
  « Virement entre comptes » form writes both legs of an internal transfer in one go
  (linked by a shared identifier, deletable as a whole, never across currencies).
  Monthly budgets per category and currency complete the picture: a positive planned
  amount, duplicates for the same month refused, currencies kept separate with no
  conversion, a one-click copy of the previous month's envelopes, and rolling 3-month
  averages shown as suggestions (display only, never stored).
  A **Comparaison** card on the Analyse tab reads the displayed month against the
  previous one and the same month a year earlier, per currency and per category.
  A **Suivi** tab compares that plan with reality: planned, actual and remaining per
  category and currency, with per-currency totals for the spending envelopes and the
  income goals under the table, over operation dates only, with refunds reducing their
  category and never a conversion between currencies.
  A **Prévisions** tab materialises the month's expected occurrences of recurring
  series — rent, subscriptions, salaries. Nothing counts in a total until a
  confirmation: confirming creates the transaction through the same path as a manual
  entry, while passing or discarding records an auditable decision and writes nothing;
  a series is stopped with its end date rather than deleted once an échéance is decided.
  The month's salary prévision from the simulator appears there too, as the first row of
  the échéances with its registration in place; once recorded it joins the month's
  decisions. Above the list, per-currency totals show the month's prévisionnel —
  expected income, expenses and net, confirmed movements included, passed and dismissed
  ones excluded — and below it a six-month scheduler lays out the coming échéances from
  the calendar (the simulated salary stays out of it: its calendar does not exist yet).
  Series run monthly, quarterly or yearly and can be edited — moving the cadence or the
  start date rebuilds the pending occurrences, and the start date locks once a decision
  exists.
  An **Objectifs** tab tracks savings or repayment targets: a positive target amount in
  one currency and a target date, with the current amount taken from the recorded
  balance of a linked account or from a manual starting amount completed by a dated
  contribution log (never ledger transactions).
  Progress is shown as an amount and a percentage, with the remaining and the monthly
  contribution — remaining divided by the whole months left, rounded half-up on cents —
  and a deadline that has passed or a reached target states why no contribution is
  defined. Missing or empty data reads "unknown", never zero, and no currency is ever
  converted (a linked account must match the goal's currency).
  Above the goals, a **seuil d'épargne conseillé** states the cushion a savings account
  should hold: six months of expected expenses (current month included) summed from the
  recurring series of the Prévisions tab, per currency and never stored, with a runway
  in months next to it. It reads the
  recorded balance of the accounts typed as savings — an unrecorded account stays
  unknown, never zero.
  A **Salaire** tab simulates earnings from an hourly rate **set per month** (a change
  point: it applies from the month you save it on, until the next one): one click on the
  calendar plans a day, a second marks it really worked, a third clears it. A booking
  button records the month's simulated amount (planned and worked days, each counted
  once, at that month's rate) as one income entry, in a default « Salaire » category —
  nothing is written before that click.
  A **Comptes** tab manages the reference data: recorded balances and the projected
  end-of-month balance per account (recorded balance + the month's pending occurrences,
  never the simulated salary), account rename/retype (the currency only while the
  account is empty), reversible archiving, and category rename, merge (repoints
  transactions, series and budgets, counting deleted duplicates out loud) and deletion
  with each category's usage shown before the click.
  A **CSV import** page (`/budget/import`) is the deliberate manual alternative to a
  bank connector: the file is parsed in the browser, the columns are mapped on a
  preview (signed amount or debit/credit pair, day-first French dates, parentheses for
  negatives), duplicates are skipped on request, and only the normalised rows reach a
  Server Action that validates everything again — nothing is uploaded before the
  preview, and nothing is sent to a third party.
  Submitted values stay in the transaction and cashflow forms, so a second line is a
  small edit; the one-shot forms (account, category, property, password) clear themselves.
- Alerts: an **Alertes** page watches six deterministic rules — low account balance,
  budget overrun, budget threshold (the preventive one, below 100 % of an envelope,
  resolved when the overrun takes over), expense above a threshold, stale synchronisation,
  overdue property
  cashflow — each with its own configurable threshold and an explanation spelled out
  next to the setting. The engine runs on demand (opening the page or the dashboard),
  and the dashboard shows a banner as soon as an alert is active. Every alert states the
  data that triggered it; duplicates are suppressed by a fingerprint (rule + entity +
  period), dismissing one silences it until the situation resolves, and nothing ever
  writes to the ledger automatically. Missing data is never treated as an anomaly: an
  account with no operation, a never-synced connection or a partially-read month keeps
  the rule quiet.
- CSV exports: transactions (a month by default, `?year=YYYY` for a year or `?all=1`
  for every month, plus account/category/type/text/reconciliation filters and a
  `pointe_le` column), budgets (month or a whole-month window), goals and alerts (status
  filter), plus the properties file — all behind the session, `no-store`,
  formula-neutralised, and bounded at 10 000 rows rather than streamed (the decision is
  documented in the architecture notes). `X-Export-Truncated: true` says the cap cut the
  file. `/api/export?entity=transactions|properties|budgets|goals|alerts` selects the
  same builders as the per-entity routes; an unknown entity answers 400 before any read.
  `from`/`to` (`YYYY-MM-DD`, both inclusive) select an explicit window and win over the
  month/year/all scopes; a malformed or reversed window is refused with a 400 rather than
  silently exporting another period. Every delivered file writes one audit entry (scope,
  bounds, row count, truncation); a file whose entry cannot be written is withheld. An
  unknown value exports as an empty cell with its reason, never as a zero.
- Real estate: properties and cashflow entries entered from the real-estate
  page, occupancy status, totals, due dates. A **Financement** card tracks the loans
  of a property — capital, a dated outstanding-balance snapshot, rate, term, monthly
  payment and insurance — with create, edit and delete, kept deliberately apart from
  the operating figures: financing never enters the property totals, and a missing
  balance or rate reads "inconnu", never zero.
- Property detail page (`/real-estate/{id}`): acquisition price, append-only valuation
  history and current equity,
  full history (purchase, cashflows, loans, valuation, sale), and a **sale indicator**
  computing the net invested capital, the break-even sale price and the target price
  (break-even + the property's margin). A property can be edited, **sold** (date,
  price, costs — the page then shows the net proceeds and the gain) or **deleted**
  with its cashflows and loans; the removal panel asks which of the two is meant.
  Missing prices, costs or loan balances read "inconnu", never zero.
- Property performance indicators (property detail, « Indicateurs de performance »):
  rental income, operating expenses, NOI, gross and net yield, occupancy and cash flow
  after financing, over one explicit twelve-month window — the last twelve months
  (default) or a calendar year, chosen with `?period=`. A figure that cannot be
  computed says why (no acquisition price, incomplete year, another currency, missing
  loan payment) instead of showing a zero, and a window without any cashflow prints no
  figures at all.
- GitHub / GitLab connections: read-only adapters, encrypted tokens, manual
  synchronisation, project snapshots, and a small GitHub: open issues and pull
  requests counted per repository, an explorer with combinable filters (repository,
  type, assignee, label, milestone, state, text), an actionable **work queue**
  (unanswered issues, old pull requests, work without a milestone or a label, blocked
  work, milestones due soon or overdue — each item with its age and a link to the
  provider), milestones with their due dates and progress, bounded **activity
  metrics** (open pull requests, their median age, inactive repositories, open-milestone
  completion; open-to-merge time and issue throughput shown as unavailable),
  **repository health** indicators (inactive, issue backlog, overdue milestones, no
  description, no topics, no default branch — each with its rule and a link to the
  provider), and **CI status** (the latest GitHub Actions run of each workflow, most
  recent first, linked to GitHub; needs `actions:read` on the token). Issue and
  milestone requests are conditional (`ETag` / `Last-Modified`): an unchanged
  repository answers 304 and is not rewritten, and the page shows when each was
  checked versus changed. GitLab stays on project metadata, on purpose — pipelines
  included.
- Global search (`/search`, with its field in the header of every page): one bounded
  query across transactions, accounts, properties, projects, issues and milestones,
  grouped by type, with the `/` shortcut. Only the modules active in the workspace are
  searched, every read is owner-scoped, each type is limited to five rows (the page
  says when more exist and links to the module), and provider results come from the
  stored snapshots with their state stated — not connected, never synchronised, failed
  or stale — instead of being presented as current.
- Dashboard with indicators derived from real data — including the month's budget
  tracking, planned versus actual per currency and kind — distinguishing "no data",
  "not connected" and "synchronisation failed".

Not implemented yet:

- Cashflow entries cannot be edited or deleted from the interface yet
  (properties, loans, transactions, budgets, goals, recurring series, accounts and
  categories all can).
- A scheduler entry point for automatic synchronisation (the function exists and
  is idempotent; the trigger is not shipped).
- Bank connection, payments, accounting, tax advice — permanently out of scope (the
  CSV import is manual on purpose).
- Document storage.

## Prerequisites

- Node.js 22 or later
- Docker, for the local PostgreSQL

## Quick start

```sh
# 1. Install dependencies (also generates the Prisma client)
npm install
npm run db:generate

# 2. Local configuration
cp .env.example .env
#    then fill AUTH_SECRET and INTEGRATION_ENCRYPTION_KEY:
#    openssl rand -base64 32

# 3. Start PostgreSQL and prepare the database
docker compose up -d --wait db
npm run db:migrate
npm run db:seed          # creates the owner from SEED_OWNER_* variables

# 4. Run
npm run dev              # http://localhost:3000
```

Ports 3000 (application or proxy) and 5432 may already be used by another local project.
Use `PORT=3100 npm run dev`, set `APP_PORT` or `PROXY_PORT` (see
[The proxy and the address you browse](#the-proxy-and-the-address-you-browse)), and set
`POSTGRES_PORT` in `.env` (keeping `DATABASE_URL` consistent) when 5432 is taken.

### Full stack in containers

```sh
docker compose --profile full up -d --build
```

The `migrate` service applies pending migrations, then the `seed` service creates
the owner account from `SEED_OWNER_*`, or refreshes the name of the one that exists.
Both exit; `app` starts only once they succeeded, so a failed migration or a missing
account never boots a server. Inspect them with
`docker compose --profile full logs migrate seed`.

The seed is idempotent and runs on every `up`. It writes `SEED_OWNER_PASSWORD` when
it creates the account, then leaves the stored hash alone: a password changed from
the **Compte** page survives a restart. To put the environment value back in force —
which is also how a forgotten password is replaced — set
`SEED_OWNER_FORCE_PASSWORD=true` and run `up -d` again, or run that step alone with
`docker compose --profile full run --rm seed`. The seed prints which of the two it
did.

Without a profile, `docker compose up -d` starts PostgreSQL only.

The Prisma CLI stays out of the application image: it is a dev dependency
weighing about 210 MB with its engines, and it is not traced into the standalone
server output. Migrations and the seed run from the dedicated `db-tools` stage
(see `Dockerfile`), which also has the `tsx` runner and the source modules the
seed imports.

### Changing the password

The **Compte** page (`/account`) shows the owner's address and name, and changes the
password. Three rules are enforced on the server, not in the interface:

- The current password is required and verified with bcrypt before anything is
  written, so an open session alone cannot lock the owner out of their own data.
- The new password must be at least 12 characters, and at most 72 bytes: bcrypt reads
  no more than 72 bytes, so a longer one would quietly open the same account as its
  own first 72 bytes. An accented letter counts for two bytes.
- A successful change signs **every** session out, this one included. Session tokens
  carry a fingerprint of the password hash they were issued for, and `getSessionUser`
  compares it with the stored row, so a change made on one device also disconnects the
  others. Tokens issued before this check existed are refused once and require one
  sign-in.

Because the password then differs from `SEED_OWNER_PASSWORD`, the seed no longer
overwrites an existing hash — see the note above. A forgotten password is replaced
from the server, with `SEED_OWNER_FORCE_PASSWORD=true`; there is no self-service
recovery, on purpose.

### The proxy and the address you browse

The `full` stack can put a small reverse proxy in front of the application: it is the
front door, and the address to type is the origin described by `APP_HOST`, published on
`PROXY_PORT`. The proxy comes from `compose.override.yaml`, which Docker Compose loads
automatically; without that file, the application port is published directly
(`APP_BIND_HOST:APP_PORT`), as after the hotfix that removed the proxy.

`.env.example` describes `http://localhost:3000` / `3000`, which works for direct access
and through the proxy. To use the origin the override falls back to when the variables
are unset, set all three to `http://dashboard.localhost:8888` / `8888`.

```sh
# AUTH_URL, APP_HOST and PROXY_PORT must describe one single origin in .env
docker compose --profile full up -d --build
```

Remove or rename `compose.override.yaml` to go back to direct access.

Three variables describe that single origin, and they are not independent. A mismatch
is invisible in `docker compose ps`: it only shows up in the browser.

- `PROXY_PORT` is the port published on the host: `3000` in `.env.example`, and the
  fallback when the variable is unset is `8888`.
- `APP_HOST` is the site address the proxy answers for. It carries the same port,
  because Caddy listens on the port of its site address.
- `AUTH_URL` is the origin the application is told to use for absolute URLs, the
  sign-in callback in particular.

Without the override, the application is published on `APP_BIND_HOST:APP_PORT` (3000 by
default). With it, the app is no longer published at all: the proxy is the only entry
point, and the app is reachable from the Compose network with `docker compose exec app`.

`APP_HOST` also decides the scheme. `http://dashboard.localhost:8888` serves plain
HTTP, which is what you want locally: there is no certificate to install. A bare
hostname (`APP_HOST=dashboard.example.com`) makes the same file serve HTTPS with an
automatically obtained certificate, which is what you want on a server — set
`PROXY_PORT=80` (or `443`) there, so the URL needs no port.

The default needs no hosts entry: `.localhost` and its subdomains are reserved for
loopback (RFC 6761), and current browsers and `curl` resolve them to this machine on
their own. Any other name does need one:

```sh
echo "127.0.0.1 budget.etib.test" | sudo tee -a /etc/hosts
# then set APP_HOST=http://budget.etib.test:8888 and AUTH_URL=http://budget.etib.test:8888
```

Two failure modes are worth recognising, because neither looks like an error:

- A name the proxy was not configured for gets an **empty page**, not a 404. A blank
  tab normally means the address you typed and `APP_HOST` differ: typing
  `localhost:8888` against an `APP_HOST` of `dashboard.localhost:8888` is exactly this,
  because the two are different hosts, not two spellings of one.
- A mismatched `AUTH_URL` signs you in on a different origin than the one you typed,
  because the session cookie belongs to a single host.

Three reasons to go through the proxy rather than publishing the application directly:

- **Auth.js needs to be told its public origin.** The standalone server otherwise
  derives absolute URLs from its own container identity and internal port
  (`http://<container-id>:3000`), which no browser can reach: the sign-in callback
  would point there. `AUTH_URL` is what makes that origin explicit.
- **Cookies are per host**, so a session opened on one host is not shared with another.
  Pick one origin and stay on it: `AUTH_URL` and the address you type must match, or you
  will be signed in on one and unknown on the other. Cookies ignore the port, so
  `dashboard.localhost` and `dashboard.localhost:8888` would share a session: changing
  the port alone never signs you out, changing the host does.
- The proxy also keeps `Host` and `Origin` aligned, which is what the Server Actions
  check before accepting a form submission.

Why these names: `.localhost` (RFC 6761) and `.test` (RFC 2606) are both reserved and
can never resolve publicly — unlike `.local`, which is mDNS territory, or an invented
name that could exist one day. `.localhost` has the advantage of needing no
configuration at all, which is why it is the name documented for the hostname
alternative.

The proxy belongs to the `full` profile, so it starts and stops with the application:

```sh
docker compose --profile full logs proxy
docker compose --profile full ps
docker compose --profile full down
```

It used to live in a profile of its own, which meant a forgotten flag left the front
door refusing connections while `app` and `db` looked healthy — the proxy depends on
`app`, so the two belong together. `docker compose up -d` with no profile still starts
PostgreSQL only.

Publishing the proxy port is now part of the full stack. Set `PROXY_PORT` if something
else already holds it.

## Environment variables

`.env.example` lists every variable with a comment; copy it to `.env` and replace
the fictitious values. The ones that matter most:

| Variable | Role |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Server only. |
| `AUTH_SECRET` | Signs the session JWT; 32 characters minimum (`openssl rand -base64 32`). |
| `INTEGRATION_ENCRYPTION_KEY` | AES-256-GCM key protecting provider tokens at rest: 32 bytes, base64 encoded. |
| `AUTH_URL` | The public origin, needed behind the proxy. It must equal the address you browse — see [The proxy and the address you browse](#the-proxy-and-the-address-you-browse). |
| `AUTH_TRUST_HOST` | Auth.js host trust; the compose stack sets `true`. |
| `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`, `SEED_OWNER_NAME` | Create the single owner account. There is no public sign-up. |
| `SEED_OWNER_FORCE_PASSWORD` | `true` overwrites the stored hash with `SEED_OWNER_PASSWORD`; left unset, a password changed from the Compte page is kept. |
| `NEXT_PUBLIC_DEFAULT_CURRENCY`, `NEXT_PUBLIC_DEFAULT_TIME_ZONE` | Interface defaults (`EUR`, `Europe/Paris`); the only variables shipped to the browser. |
| `APP_BIND_HOST`, `APP_PORT` | Host interface and port published by the Compose application (`0.0.0.0:3000` by default). Use `APP_BIND_HOST=127.0.0.1` for local-only access. |
| `APP_HOST`, `PROXY_PORT` | Address and host port served by the proxy when that proxy is enabled. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Credentials and host port of the local PostgreSQL container. |

The server-only variables are validated by `src/lib/env.ts` on first use: a missing
secret fails loudly with the variable names instead of surfacing later as an obscure
error. `NEXT_PUBLIC_*` values are inlined into the client bundle at build time, so a
secret must never be added to that block.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run db:generate` | Generate the Prisma client into `src/generated/prisma` (required before typecheck, tests or build) |
| `npm run db:migrate` | Create and apply a migration (development) |
| `npm run db:deploy` | Apply pending migrations (deployment) |
| `npm run db:seed` | Create the owner account, or refresh its name (the stored password is kept) |
| `npm run db:cleanup` | Delete synchronisation runs older than the retention window (keeps the latest success per connection) |
| `npm run db:studio` | Browse the database |

## Project structure

```text
src/
  app/                 # pages, layouts, Route Handlers, Server Actions
  components/          # interface components
  modules/             # business rules, per module
    identity/ budget/ real-estate/ integrations/ alerts/ catalog/ search/ dashboard/
  lib/                 # database, configuration, cross-cutting utilities
  jobs/                # synchronisation tasks run server-side
  generated/prisma/    # generated client, not committed
prisma/                # schema, migrations, seed
infra/backups/         # backup and restore scripts
docs/                  # architecture and decisions
compose.yaml
```

## Conventions worth knowing

- Money uses exact decimals, never floats. Negative amounts are outflows.
- A transfer counts as a real movement: the monthly balance **includes** it, on the side its
  sign puts it (negative → expenses, positive → income), and its volume is shown separately
  as a subset. Every indicator definition is documented in
  `docs/architecture/overview.md`.
- Operation dates are calendar days; instants are stored in UTC.
- Secrets stay server-side. `.env` is git-ignored; only `.env.example` is
  versioned, with fictitious values.
- Provider tokens are encrypted with AES-256-GCM before being stored.
- Amounts are typed with a sign: a rent is `900,00`, a charge is `-45,90`. A
  positive amount on an expense is a reimbursement. The amount is read in the
  currency of its account, which is never asked for twice.
- A property cashflow is either a typed amount **or** a link to a transaction,
  never both: otherwise the same money would be counted twice.
- The write forms validate in the browser with zod (react-hook-form) and the
  Server Action validates the same payload again before touching the database.

## Synchronisation

One run can be triggered from the integrations page. Automatic scheduling is not
wired yet: the repository deliberately ships no cron unit or platform job, only
the idempotent functions in `src/jobs/sync.ts` that such a trigger should call.

A run is idempotent: replaying it updates snapshots instead of duplicating them.
Nothing is written when a run fails halfway, and the previous successful
synchronisation is kept for display.

Every attempt is recorded as a `SyncRun` row: status (`SUCCESS`, `PARTIAL` or
`FAILED`), counters, duration, retries and a safe error code. The integrations page
shows the latest run per connection and a bounded history, and the dashboard flags a
connection whose last success is older than 24 hours. A partial run names the
repositories it did not read — their data is unknown, never zero.

Transient failures (network errors, HTTP 429, HTTP 5xx, a spent GitHub quota) are
retried with bounded backoff; authentication, permission and not-found refusals are
final. The number of retries is kept on the run.

Run history is kept for 90 days (`SYNC_RUN_RETENTION_DAYS`), except the most recent
successful run of each connection. `npm run db:cleanup` applies the policy and is safe
to re-run; nothing schedules it. Provider snapshots are current state, not history: a
run replaces them, and closed issues leave the list, so they are not subject to this
retention.

## Tests and CI

`npm run test` runs the unit tests once (Vitest); `npm run test:watch` keeps them
running. No test connects to a database or performs a real network call: business
rules are called directly, provider adapters receive an injected fake `fetch`, and
the action-level tests mock their modules. They cover what is expensive to get
wrong: money and date handling, monthly totals (transfers counted by sign, refunds,
currencies), CSV escaping and formula neutralisation, the export routes and the umbrella
selector (filters and their boundaries, invalid windows, empty files, bounded reads,
truncation header, owner scoping, audit entries), the audit metadata redaction, the
password policy
and the session guard, provider failure cases, issue filters and milestones.

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
install, generate the Prisma client, lint, type check, unit tests, apply the
migrations on a fresh PostgreSQL service container, then build. The secrets it uses
are fictitious values that only let the build run.

## Operations

Operational runbooks live in [`docs/operations/`](docs/operations/README.md): local
setup, migration deployment, backup and restore, provider token rotation, failed
synchronisation recovery, smoke verification and production diagnostics. They use the
repository's own scripts and fictitious values only.

## Before production

- Configure HTTPS through a reverse proxy; keep PostgreSQL off the public
  network.
- Provide real secrets through the environment, never through an image layer.
- Schedule `infra/backups/backup.sh`, store backups encrypted off the host, and
  run `infra/backups/verify.sh` on each one. The full procedure, including a restore
  rehearsal and a recovery sequence, is in
  [`docs/operations/backup-restore.md`](docs/operations/backup-restore.md); script
  internals are in `infra/backups/README.md`.
- Apply migrations and create the owner before the application starts: the
  `migrate` and `seed` services do both, or run them alone with
  `docker compose --profile full run --rm migrate` / `run --rm seed`.
- `SEED_OWNER_PASSWORD` is written when the seed creates the account, or when
  `SEED_OWNER_FORCE_PASSWORD=true`: a password changed from the Compte page survives
  a restart or a redeploy. Keep the value out of the image; rotate it by editing
  `.env` and forcing one seed run.

## License

Released into the public domain — see `LICENSE`.
