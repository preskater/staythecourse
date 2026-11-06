# Architecture

Personal steering dashboard: software projects, GitHub/GitLab activity,
real-estate assets and a personal budget. One application, one server, one
database — a modular monolith, deliberately.

## Modules

Business rules live in `src/modules/<module>`, not in pages or Route Handlers.
Each module exposes a `domain.ts` (types and rules, no I/O), a `repository.ts`
(database access scoped to the owner) and, when the module has an interface,
the pages that consume it.

| Module | Responsibility | Key files |
| --- | --- | --- |
| `identity` | The owner account and workspace memberships (roles `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`) and their permission presets. No public sign-up: the account and its personal workspace are created by the seed script. | `repository.ts`, `workspace.ts`, `permissions.ts` |
| `catalog` | Module catalog (stable keys, prerequisites, configuration schemas) and per-workspace activation. Navigation and the module guards read from it. | `catalog.ts`, `repository.ts` |
| `budget` | Accounts, categories, transactions, monthly budgets, budget follow-up, salary simulation, recurring forecasts, financial goals, the savings threshold and monthly aggregation. | `domain.ts`, `totals.ts`, `salary.ts`, `report.ts`, `recurrence.ts`, `goals.ts`, `savings.ts`, `transactions.ts`, `repository.ts` |
| `real-estate` | Properties, cashflow entries, due dates, the double-counting rule, financing and property indicators. | `domain.ts`, `kpis.ts`, `repository.ts` |
| `ai-costs` | Exact cost amounts, each with a mandatory actuality and an immutable source reference. Primitives only: no persistence, provider call or allocation yet (M9-01). | `domain.ts`, `actuality.ts`, `source.ts`, `money.ts`, `amount.ts` |
| `integrations` | Read-only GitHub and GitLab connections, provider adapters, snapshots. | `domain.ts`, `adapter.ts`, `github.ts`, `gitlab.ts`, `repository.ts` |
| `alerts` | Deterministic warning engine: rule configuration, one bounded evaluation pass, episode lifecycle (fingerprint suppression, dismissal). Rules sit next to their data: `budget/alerts.ts`, `integrations/alerts.ts`, `real-estate/alerts.ts`. | `domain.ts`, `lifecycle.ts`, `refresh.ts`, `repository.ts` |
| `search` | Global search across the owner's own entities and provider snapshots, one bounded and grouped result set per query. | `domain.ts`, `repository.ts` |
| `dashboard` | Read-only aggregation for the home page. | `queries.ts` |
| `audit` | Append-only trail of security-sensitive and data-changing actions (exports today). Codes, counts and calendar days only. | `domain.ts`, `repository.ts` |

Cross-cutting code sits in `src/lib` (`db`, `env`, `money`, `dates`, `csv`,
`crypto`, `auth`). Background work sits in `src/jobs` and is triggered from
outside the web process.

## Request flow

```mermaid
flowchart LR
  B[Browser] --> P[proxy.ts<br/>redirect if no session]
  P --> Y[Page / Route Handler / Server Action]
  Y --> G["requireUser() / requirePermission() / requireModule() / requireApiAccess()"]
  G --> M[Module: business rules]
  M --> R[repository.ts]
  R --> D[(PostgreSQL)]
```

Two checks, one authority. The proxy only improves the user experience; the
real authorisation check is `requireUser()` (pages), `requirePermission()` and
`requireModule()` (Server Actions) or `requireApiAccess()` (Route Handlers),
executed on the server for every request. Route Handlers answer `401` with a JSON
body rather than redirecting, which is why API routes are excluded from the proxy
matcher.

### Roles and permissions (M7-05)

A membership carries one of four presets. `src/modules/identity/permissions.ts` is the
only matrix; the guards compose it with the session and the active workspace.

| Role | read | write | export | manage-modules | manage-members |
| --- | --- | --- | --- | --- | --- |
| `OWNER` | yes | yes | yes | yes | yes |
| `ADMIN` | yes | yes | yes | yes | yes |
| `MEMBER` | yes | yes | yes | no | no |
| `VIEWER` | yes | no | no | no | no |

- **Deny-by-default.** A permission absent from a preset is refused; an unknown role or
  permission is refused too. `getSessionUser` requires `read`, and `requireModule` takes
  the permission explicitly — there is no default that a new action could inherit by
  omission.
- **Writes.** Every mutating Server Action on workspace data calls
  `requireModule(key, "write")` (or `requirePermission("write")` for alerts, which has no
  catalog module). A viewer's forged POST therefore reaches no repository call. Module
  settings check `hasPermission(role, "manage-modules")`; the account page's own
  password and session actions ask only for the session, since they touch the caller's
  credentials and no workspace data. The only read-only action, `simulateExpenseAction`,
  asks for `read`.
- **Exports.** Every CSV export goes through `serveCsvExport` in
  `lib/export-route.ts` (the per-entity handlers and the umbrella `/api/export`), which
  calls `requireApiAccess("export", …)` before any read: `401` when signed out, `404`
  when the module is disabled, `403` with `{"error":"forbidden"}` when the role lacks
  `export`. The audit entry is written only after the permission check.
- **Member management.** `canRemoveMember` and `canChangeMemberRole` never let an admin
  (or anyone else) remove or demote an owner, and nobody grants `OWNER` through this
  path. Transferring ownership will be a separate, explicit operation (M8-01); role
  changes will be audited with M18-02.
- **Server-side only.** Pages may hide a control for comfort, but no component decides
  access: the role is read from the session's membership on every request.

### Write path

Writes go through Server Actions, never through a Route Handler:

```mermaid
flowchart LR
  F["Form (client)<br/>react-hook-form + zod"] -->|values| A["Server Action<br/>requireModule(key, "write") first"]
  A --> V["Module schema,<br/>re-validated"]
  V --> O["Owner-scoped lookups<br/>findAccount / findProperty"]
  O --> R[repository.ts]
  R --> D[(PostgreSQL)]
```

- The form validates in the browser for comfort; the action validates again with
  the same schema, because a request body can always be replayed by hand.
- Every identifier sent by the browser (account, category, property, transaction)
  is looked up with the owner's id: a foreign identifier is simply not found.
- The action answers `ok`, `invalid` or `error`. `invalid` carries per-field
  messages; `error` is generic and logs only the error type, never a payload.
- A transaction takes its currency from its account, and a linked cashflow entry
  takes it from its transaction. The browser never picks a currency that could
  contradict the row it belongs to.
- After a write, the action revalidates the affected paths (`/budget`,
  `/real-estate`, `/dashboard`); nothing is cached across owners.

### Quick actions (UX-02)

Convenience paths reuse the write path above; none of them is a second one.

- **Quick entry**: the dashboard's « Nouvelle opération » card renders the budget
  page's own `TransactionForm` — same `transactionFormSchema`, same
  `createTransactionAction`, same `keepValues` behaviour and feedback.
  `quick-transaction-card.test.ts` checks the schema it resolves with.
- **Filter shortcuts**: links above the budget filters, built by
  `buildFilterShortcuts` on the query parameters the filter form already submits. A
  preset (« Non pointées », « Dépenses », « Recettes ») replaces the filters and keeps
  the month; a period (« Mois en cours », « Mois précédent », « Tous les mois ») keeps
  the filters and changes the window.
- **Keyboard**: `n` focuses the label of the page's creation form, `/` the « Libellé
  contient » search. Targets carry `data-shortcut`; keys typed in a field or with
  Ctrl, Cmd or Alt are ignored, and a page without the target ignores the key. The
  shortcuts only move the focus, they never submit. When a page has no local search
  field, `/` falls back to the header's global search (`SHORTCUT_FALLBACKS`).

### Global search (UX-01)

One GET form in the header of every private page, plus its `/search` page: the query is
read on the server, never in the browser.

- **Scope follows the modules.** `searchableKinds` maps each kind to its module
  (`budget` → transactions and accounts, `real-estate` → properties, `development` →
  projects, issues, milestones); a disabled module is not searched at all.
- **Every read is owner-scoped**: `workspaceId` on the owner's own rows, and
  `connection: { workspaceId }` on provider snapshots. No provider is contacted per
  query: results come from the stored snapshots (DR-02).
- **Bounded, not paginated.** Each kind reads `limit + 1` rows and returns at most the
  limit, so "more results exist" costs one row rather than a count query per kind. The
  page states the bound and links to the module (`/budget?all=1&q=…` for a text search).
- **States stay distinct**: no result, provider not connected, never synchronised, and
  a failed or stale synchronisation each read differently. A stale snapshot is labelled
  as such instead of being shown as current.
- `normalizeSearchQuery` trims and collapses whitespace, requires two characters and
  truncates a long paste; nothing is read for a shorter query.

### Deletion

A transaction can be removed from the budget table, after a confirmation step that
names the line. There is no bin: the row is gone, which is why the confirmation is a
step of its own rather than a single click.

A transaction linked to a property cashflow is **refused**, with the property named.
The relation is declared `onDelete: SetNull`, so the database would otherwise null the
link and leave the cashflow with neither a transaction nor an amount — the one state
`resolveCashflowAmount` throws on, which would break that owner's property totals for
a row they can no longer see. Refusing is louder and safer than a cascade nobody
asked for: a cascade here would silently change what a property is worth.

## Data conventions

- **Amounts** are exact decimals (`numeric(18, 2)`), never floating point. The
  sign is meaningful: an outflow is negative. A refund is a positive amount on
  an `EXPENSE` transaction.
- **Instants** (creation, update, synchronisation) are `timestamptz` in UTC and
  displayed in the time zone configured for the interface.
- **Operation dates** are calendar days (`DATE`), with no time and no time zone.
  Monthly aggregations bucket on them, so no offset can move a line into a
  neighbouring month. The end-of-month bound is exclusive.
- **Currencies** are stored per row. A total is always computed per currency;
  mixing currencies raises an error instead of inventing an exchange rate.
- **Cost ledger primitives** live in `src/modules/ai-costs` and follow the same money
  rules. A provider export may carry more than two decimals; it is rounded **half-up
  to the cent** exactly once, at the boundary (`roundToCents`), and the original
  currency is kept — nothing is converted. Every `CostAmount` also carries a mandatory
  **actuality** (`observed`, `derived`, `allocated`, `estimated`, `reconciled`) and an
  immutable **source reference** (`provider`, `import`, `manual`). `money: null` means
  unknown: a total containing one unknown amount is `null`, never a partial sum and
  never zero, and an empty set is also unknown because "no data" is not "zero cost".
  `source.capturedAt` is a UTC instant; `operationDate` is a calendar day. The two
  answer different questions and are never derived from one another. Source references
  are frozen, hold identifiers only, and reject token-shaped values, so a secret is
  never stored as a source.
- **Imports** are made re-runnable by a unique constraint on
  `(accountId, externalRef)`: replaying an import fails loudly instead of
  duplicating a line. The manual CSV import (page « Importer un CSV », see below) uses
  the `import:` prefix so its references can never collide with an internal one
  (`salary:`, `forecast:`), and its duplicate rule is *same operation date, same label
  (whitespace collapsed), same amount* — checked against the account's rows and within
  the file itself, and applied only when the owner asks for it.
- **Transfers** carry their sign like every other amount. A transfer entered through the
  « Virement entre comptes » form writes **two linked movements** in one database
  transaction: the source leg negative, the destination leg positive, both sharing a
  `transferGroupId`, both in the accounts' currency (a linked transfer never crosses
  currencies). The pair is one thing: each leg can be ticked against its own statement,
  editing one leg alone is refused (the two halves could diverge), and deleting either
  leg deletes both, with the confirmation and the answer saying so. A single-leg
  transfer stays possible (money sent somewhere untracked): it is simply typed by hand
  and carries no group.
- **Reconciliation** is a per-row day (`reconciledAt`), set or cleared by the
  « Pointer » button on the operations table: it records *the day the line was checked
  against a bank statement* and never touches the amount, the date or the account. A
  filter (toutes / non pointées / pointées) exists on the filters card and in the CSV
  export (`pointe_le` column, empty when unchecked — a state, not a missing date).
- **Categories** carry a kind (`INCOME` or `EXPENSE`), and a transaction may only use
  a category of its own kind — `categoryKindForTransactionType` is the single source
  of that rule, used by the form to filter the list and by the Server Action to refuse
  a replayed request. A `TRANSFER` takes no category at all: it moves money rather than
  spending it, so there is nothing to label — its amount still counts in the totals, by its
  sign (see below). Categories can be renamed, merged (same kind only: transactions,
  series and budgets are repointed, budgets the target already covers are deleted and
  counted out loud) and deleted — the management screen shows each category's usage
  first, and a kind change is refused while anything references it.
- **Budgets** are planned amounts for one category, one month and one currency. The
  amount is a positive magnitude: the category's kind says whether it is a spending
  envelope or an income target, and a plan of zero or less is refused rather than
  stored. One owner carries at most one budget per `(category, month, currency)`
  tuple — the unique index that rejects a duplicate also lets the same category hold a
  EUR plan and a USD plan at once. Amounts are never converted between currencies.
- **Table footers** add one total row per currency, never a cross-currency figure, and
  aggregate **every non-text column**: the accounts table totals the recorded balance, the
  low-balance threshold, the pending échéances and the projected balance, and counts the
  accounts (active/archived) and the date of their latest operation; the goals table totals
  the « Reste » and the monthly contributions, counts the goals and shows the closest
  deadline; the budgets table totals the planned amounts and the rolling average; the
  operations table totals the filtered rows (every filtered row, not only the displayed
  page); the échéances table totals what still waits for a decision.
  The goals' « Progression » footer is the group's **weighted accomplishment**,
  `Σcurrent ÷ Σtarget × 100` (one decimal, half-up — the same rule as a single goal, and
  never the mean of the row percentages, which would weigh a 5 € goal like a 5 000 € one);
  a non-positive sum reads 0 %.
  A footer reads « — » as soon as one of its rows holds an unknown amount (an account with
  no operation, an automatic threshold, a goal without a source or with a passed deadline,
  a category without an average): the known rows are still summed, but an unknown is never
  counted as a zero.
- **Salary simulation** lives in the budget module and writes nothing by itself: one
  hourly rate per owner, and one `WorkDay` per clicked day whose status is the level
  reached — `PLANNED` feeds the simulated budget, `WORKED` the amount really earned, and a
  third click removes the row. The rate is the only stored figure; the day, week and month
  equivalents shown next to it are derived from the configured day length and a 5-day
  week (`salaryEquivalents`). Booking is a deliberate, separate click: it creates one
  INCOME transaction for the month (amount recomputed from the **clicked days** —
  planned and worked, each counted once — category « Salaire » created when missing,
  stable reference `salary:YYYY-MM` so a month cannot be booked twice). The « Prévisions »
  tab shows that same prévision as the first row of the month's échéances, its
  registration form in the row; once recorded, the booking appears among the month's
  decisions, dated by the transaction's creation instant. Both doors call one action.
  Until that click the simulated amounts stay out of the totals.
- **Recurring forecasts** describe an expected income or expense (rent, subscription,
  salary): a label, a positive magnitude, a direction, an account, an optional category,
  a cadence (`MONTHLY`, `QUARTERLY`, `YEARLY`), a start date and an optional end date. A
  definition writes nothing to the ledger. Opening the « Prévisions » tab materialises
  the month's occurrences idempotently — the unique `(recurring, date)` and
  `skipDuplicates` make the write safe to repeat, and a decided occurrence keeps its row,
  so it is never reset to pending or offered twice. An occurrence falls on the start
  date's day of month, clamped to the month's last day (the 31st → 28/29 February); the
  clamp does not propagate, so March falls on the 31st again. A month that does not align
  with the cadence (quarterly: every third month from the start month; yearly: the start
  month) holds no occurrence. Confirmation is the only door into the accounts: it reuses
  the manual transaction path rule for rule, dates the entry on the **occurrence day**
  and stores the stable reference `forecast:{occurrenceId}`; « Passer » and « Écarter »
  record a terminal decision with its date and write no transaction. A series can be
  **edited** — label, amount, account, category, cadence, dates; moving the cadence or
  the start date deletes the still-pending occurrences so they are re-materialised on the
  new rule, and the start date is locked once a decision exists (that history is dated).
  Deleting a series is refused while one of its occurrences carries a decision — that
  audit trail, and the link to a confirmed transaction, outlives the series — so a series
  is stopped with its end date rather than erased.
- **Financial goals** are target amounts: a name, a positive target, one explicit currency,
  a target date and a status (`ACTIVE`, `ACHIEVED`, `ABANDONED`). The current amount comes
  from one of two sources: the **recorded balance** of one linked account (the signed sum
  of its transactions), or a **manual starting amount plus the logged contributions**.
  The two are mutually exclusive; a goal may also carry neither, and its progress then
  reads « inconnue », never zero. The contribution log (`GoalContribution`) holds dated
  positive amounts and notes: it is a **log entry, not a ledger transaction** — it never
  touches an account balance — and the goal's progress moves by exactly what is logged.
  Linked goals take no contributions (the balance is the single source), and both are
  owner-scoped like every other lookup; a linked account must be in the goal's currency:
  the app refuses the link rather than converting. Goals are independent of the monthly
  windows: they describe a horizon, not a month.
- **Accounts** can be renamed, retyped and its currency changed only while the account
  holds no transaction (the app never converts, and an account's history is written in
  its currency). They are **archived**, never deleted: an archived account leaves the
  entry forms and the alert engine and keeps its history readable; restoring clears the
  stamp. Accounts and categories are managed in the « Comptes » tab.
- **Property financing** is kept apart from operating cashflow on purpose. A
  `PropertyLoan` describes the money that funds a property: a positive
  `initialPrincipal`, an optional stored `outstandingBalance` with its observation date
  (`balanceAsOf`), an optional positive interest rate (a percentage), an optional term
  in months, optional monthly `paymentAmount` and `insuranceAmount`, and optional start
  and end dates. A loan carries its own explicit currency and is owner-scoped through
  its property. **None of these amounts feeds `computePropertyTotals`**: interest,
  principal and insurance are the cost of owning the asset, not its operating result,
  and the same money already appears in the budget, so adding them to the cashflow
  totals would double-count it. A missing figure — a balance, a rate, a term — reads
  « inconnu », never zero. Currencies are never converted: financing is totalled per
  currency.

## Documented indicator definitions

- `income` — sum of `INCOME` amounts, plus the positive `TRANSFER` amounts.
- `expenses` — negated sum of `EXPENSE` amounts, so it reads as a positive
  number; reimbursements reduce it. Negative `TRANSFER` amounts are added here.
- `transfers` — absolute volume of `TRANSFER` amounts. A **subset** indicator: those
  amounts are already counted in `income` or in `expenses`, never on top of them, and the
  volume equals the sum of what they added to the two sides.
- `net` — `income - expenses`, transfers included. A transfer moves money for real, so it
  counts by its sign: recording both legs of one internal transfer leaves the net
  unchanged, while a single leg (money sent to savings, whose destination is not tracked)
  lowers it.
- Budget follow-up (budget page, « Suivi » tab) — planned versus actual for one month,
  per category and currency. It reuses the rules above rather than defining its own, so
  a figure here always equals the same figure elsewhere:
  - *planned* — the budget amount, a positive magnitude whatever the category's kind.
  - *actual* — transactions dated in the month (operation date, exclusive upper bound),
    attached to the category and carrying the row's currency only. An `EXPENSE` is
    reported positive, an `INCOME` positive, so both read in the plan's direction; a
    refund (a positive amount on an `EXPENSE`) reduces the actual, and refunds exceeding
    the spending legitimately give a negative actual. Transfers have no category by design
    and never appear; uncategorised transactions are ignored.
  - *remaining* — planned − actual. Negative on a spending budget reads « Dépassé »; an
    income goal reads « Objectif atteint » or « Sous l'objectif », never "over budget".
  - *totals* — the rows of one currency and one kind added up: one total for the month's
    spending envelopes, one for its income goals. A kind is never summed into another (an
    envelope and a goal do not read in the same direction) and no total crosses
    currencies. The Suivi tab writes them under the table, the dashboard shows them as
    cards whose colour follows the same reading as the badges; a month without budget has
    no total at all, rather than a zero.
  - Months without transactions keep their budget rows with a zero actual, and no figure
    is ever converted between currencies: a transaction in another currency does not feed
    the row.
- Salary simulation (budget page, « Salaire » tab) — a planning view whose figures are
  only written into the accounts through the explicit booking button. A day clicked once
  is `PLANNED`, clicked twice `WORKED`, a third click removes it; the two states are
  disjoint, so no day counts twice:
  - *hourly rate* — month-scoped (`SalaryRate` change points): a rate saved for a month
    applies from that month on, until the next entry. A month before the first entry has
    no rate at all — its simulation and its booking are refused rather than computed
    from an invented default. The day length and the currency are global simulator
    options (`SalarySetting`, one row per owner).
  - *planned* — sum of the hours of `PLANNED` days × the month's hourly rate.
  - *worked* — sum of the hours of `WORKED` days × the month's hourly rate.
  - *total simulated* — planned + worked.
  - *equivalents* — day = rate × configured hours per day; week = day × 5 working days;
    month = week × 52/12. Displayed for information only, never stored.
  - *booking* — one INCOME transaction per month, labelled « Salaire {mois} », category
    « Salaire » (created when missing), amount = the month's **simulated** amount
    (planned and worked days, each counted once, at the month's rate) — the very figure
    the Prévisions tab displays, so a month can be recorded as soon as it is planned.
    The unique `(account, externalRef = salary:YYYY-MM)` refuses a second booking of the
    month.
- Recurring forecasts (budget page, « Prévisions » tab) — a planning view kept apart
  from the ledger on purpose. Definitions and occurrences live in their own tables and
  feed **no actual total**: `computeMonthlyTotals`, the budget follow-up and the charts
  read `Transaction` rows, so a forecast moves a figure only on the day an occurrence is
  confirmed — and that confirmation writes an ordinary transaction (same validation,
  same aggregation rules, dated on the occurrence day). « Passée » and « Écartée » are
  decisions with a date, not hidden deletes, and both create no transaction. All dates
  are calendar days (`DATE`, UTC midnight) like every operation date; "today" and the
  default month follow the same UTC calendar (`currentMonthKey`), so a late occurrence
  is flagged against the convention every monthly window already uses. The same tab
  shows the month's **salary prévision** — computed on the fly from the simulator's
  calendar, never stored — as the first row of the échéances, with its registration in
  the row; recording it calls the same booking action as the Salaire tab, so the two
  tabs can never disagree. The **6-month scheduler** below the list projects the same
  rules forward: each month's per-currency row completes the series' occurrences with
  the month's salary — the simulation of its clicked days, or the amount already booked
  — so an upcoming month's expected net includes the wage. A month with no clicked day
  contributes no salary amount (never a zero), the scheduler never materialises
  anything, and like every forecast figure these projections stay out of actual totals.
  Each row also carries a per-currency **simulated balance**: the recorded cumulative
  strictly before the window, advanced month by month by everything dated in that month
  — recorded operations (a booked salary included: it is a real transaction) and pending
  movements (planned occurrences, simulated salary) — so no movement is counted twice and
  a month never includes money dated later. A currency with no recorded operation at all
  reads « — »: a balance that was never recorded is not a zero.
  Above the list, the tab sums the month into per-currency
  **prévisionnel** figures — expected income, expected expenses and the expected net —
  counting pending and confirmed movements (a prévision that came true is still part
  of what the month was expected to be) and excluding passed and dismissed ones. Like
  every forecast figure, these totals never feed an actual total: only recorded
  transactions do.
- Financial goals (budget page, « Objectifs » tab) — progress of a savings or repayment
  target, always shown as an amount **and** a percentage, with the currency explicit on
  every figure. The rules are fixed here so the table can be read without guessing:
  - *current* — the manual amount plus the logged contributions when the goal carries
    them; otherwise the recorded balance of the linked account (the signed sum of its
    transactions). A manual goal with neither an amount nor a contribution, or a goal
    whose linked account has no recorded transaction, reads **unknown** with the
    reason displayed — never 0: "nothing recorded" is not "nothing saved". A real
    0,00 € (an account whose movements net to zero) is shown as 0,00 €.
  - *remaining* — target − current; negative when the goal is exceeded, so an over-target
    goal stays visible as such.
  - *percentage* — current ÷ target × 100, rounded **half-up to one decimal**
    (`Decimal.ROUND_HALF_UP`). Above 100 % for an exceeded goal; a non-positive current
    reads 0 %, the overdraft being told by the amounts rather than by a negative
    percentage.
  - *months left* — whole calendar months between the current month and the target month
    (UTC). The target month itself counts as zero: the deadline falls this month.
  - *monthly contribution* — remaining ÷ months left, rounded **half-up on cents**; with
    zero months left it is the whole remaining amount (the deadline is now), and it is
    not defined once the target date has passed or the goal is reached — the table states
    the reason instead of a figure. The division is guarded, never a division by zero.
- Savings threshold (budget page, « Objectifs » tab, above the goals) — the cushion a
  savings account should hold, computed, never stored:
  - *window* — **six calendar months starting with the current one** (`savingsWindow`):
    the money must cover what is still ahead, including the month being lived through.
    Each month counts whole, whatever the day of the month.
  - *expected expenses* — the recurring EXPENSE definitions of the Prévisions tab,
    summed month by month through `occurrenceDatesForMonth` (the series' day of month,
    clamped to shorter months, nothing before the start or after the end). Income
    series are ignored; nothing is averaged or extrapolated.
  - *currency* — one threshold per currency, resolved through each series' account (the
    same rule as the Prévisions tab). Currencies are never converted.
  - *savings* — the accounts typed `SAVINGS` of that currency; their **recorded**
    balances are added up. No account is not a figure, and an account with no recorded
    transaction reads **unknown**, never zero — progress and shortfall stay blank until
    something is recorded.
  - *progress* — savings ÷ threshold × 100, half-up to one decimal; *shortfall* —
    threshold − savings, negative when the cushion exceeds the threshold. A real zero
    balance stays a known zero: 0 % and the whole threshold to constitute.
  - *runway* — how many months of expected expenses the recorded balance covers,
    `savings × 6 ÷ threshold`, half-up to one decimal: 6,0 months means the full
    cushion is there. A non-positive balance reads 0 — the debt is told by the amount —
    and an unknown balance leaves the figure blank like the rest.
- Comparison of periods (budget page, « Analyse » tab) — the displayed month against
  the previous month and the same month one year earlier, per currency, using the same
  `income` / `expenses` / `net` definitions as the totals cards above (transfers
  included by their sign):
  - a side with **no transaction at all** in that currency is not a zero month: it reads
    « — » and no delta is computed against it;
  - *net delta* — current net − previous net, signed (positive = the month improved);
  - *net percent* — the delta divided by the **absolute value** of the previous net, one
    decimal, so its sign follows the delta; `null` — displayed as no percentage — when
    the previous net is exactly zero, because dividing by zero has no honest rate;
  - the per-category detail of the displayed side of the ledger compares the three
    periods category by category; a category absent from a month that was read entirely
    is a real zero for that month, never "unknown";
  - when any of the three period reads reaches its row bound, the whole comparison is
    hidden with an explanation rather than shown partial: a truncated month would read
    as a calmer month.
- Rolling category averages (budget page, « Budgets » tab) — the display-only suggestion
  used to help set an envelope: over the **three months before the displayed one** (a
  running month is not an average yet), `computeCategoryAverages` sums each category's
  actual — expenses positive, refunds reducing, income as received, per currency — and
  divides by the **fixed** window length, empty months included, because "what does this
  category cost per month" is the question a budget answers. `activeMonths` says how
  many of the three actually hold rows. Transfers and uncategorised rows are skipped
  (there is no category key to attach them to), the average is rounded half-up on cents,
  and when the read reaches its bound the column shows "—" instead of a partial history.
  The suggestion list opens the budget form pre-filled with the average — nothing is
  stored until the form is submitted.
- Projected balance (budget page, « Comptes » tab) — the end-of-month estimate per
  account: **recorded balance + the month's pending occurrences** (the échéances the
  Prévisions tab materialised and the owner has not decided yet; an already-confirmed
  one is a real transaction and sits inside the balance already). The simulated salary is
  deliberately not added: until it is booked, no account owns it, and guessing one would
  be inventing data. On a past month the figure reads as "what was still to be processed".
  An account with no recorded transaction keeps an **unknown** starting balance: its
  projection stays "—" while the pending net is still told — nothing is made up from it.
- Expense simulation (budget page, « Simuler une dépense ») — a **read-only** scenario
  built from the same rows as the Prévisions and Suivi tabs. It writes no transaction
  and changes no threshold.
  - The total is the sum of the payments; it is never typed separately. A scenario may
    split one expense into several dated payments, possibly on different accounts.
  - A payment may omit its account. The engine then suggests a split: checking, cash
    and card accounts before other accounts, and savings last; within one family, the
    largest projected balance first. It tries to preserve the configured low-balance
    threshold, then keeps balances positive, and only in a last pass accepts going
    below the floor. Accounts without a recorded operation and archived accounts are
    never used; an amount no account can receive stays explicitly unallocated.
  - The window starts at the current month and always covers the current month plus the
    next six. A past or future payment widens it, three months follow the last payment,
    and 24 months is the hard bound.
  - *Balance before scenario* — opening balance + recorded operations + pending
    forecasts dated in the month. *Balance after scenario* — the same, plus the
    simulated payments. A confirmed forecast is already a recorded transaction and is
    never counted twice.
  - The salary simulation is a **currency-level** forecast: it advances the global
    balance but no account balance until it is booked.
  - *Account point low* — the minimum projected balance of an account over the window.
    *Global point low* — the same for the sum of the currency's accounts.
  - The floor is resolved per account, in this order: the account's own
    `lowBalanceThreshold` (Comptes tab), then a positive global `LOW_BALANCE` rule
    when it applies to the account's currency and is at least the suggestion, then a
    **suggestion of one month of expenses** — the average of the last three complete
    months, or the current month's still-pending expenses when they are higher. The
    analysis labels the source on every account. The suggestion is simulation-only;
    the alert engine uses the account setting or the global rule, and an account setting
    remains active even when the global rule is disabled.
  - A negative balance is flagged even without a positive floor. A breach already
    present before the scenario is distinguished from one the scenario causes.
  - An account with no recorded operation keeps an **unknown** balance, never zero.
    Currencies are never converted; a scenario is single-currency.
  - With a category selected, the budget impact reuses the Suivi rules (expenses
    positive, refunds reducing, transfers and uncategorised rows excluded) and, when
    the rule is enabled, applies the `BUDGET_THRESHOLD` percentage as the preventive
    alert line. A month without a budget is « no budget », not a zero envelope.
- Property totals — each cashflow entry counts once. When an entry is linked to
  a transaction, the transaction is the only source of the amount. Amounts are never
  converted: the totals are expressed in the property's own currency
  (`selectCashflowTotalsCurrency`), an entry in another currency is excluded and
  counted (`foreignCurrencyCashflows`) rather than summed, and the sale indicator reads
  the net invested capital as **unknown** as soon as one entry was excluded — a total
  covering one currency is not the property's whole result.
- Property financing (real-estate page, « Financement » card) — the loans of a property,
  shown beside the operating figures and **never added to them**:
  - *monthly cost* — the sum of each loan's monthly payment + insurance, per currency;
    « inconnu » when no loan of that currency records either, never a zero;
  - *outstanding debt* — the sum of the recorded `outstandingBalance` snapshots, per
    currency; a loan whose balance was never recorded is excluded from the total and
    counted apart (its debt is unknown, not zero);
  - *rate* — an annual percentage, positive; the two-decimal amount parser is reused, so
    a missing rate reads « inconnu »;
  - the operating totals of the property (`income`, `expenses`, `net`) are untouched by
    any loan: financing is a separate ledger of cost, not a movement of the property's
    cashflow.
- Property valuation and sale indicator (property detail, `/real-estate/{id}`) — a
  projection built only from the owner's recorded amounts. It forecasts no market
  price and is not investment advice. Prices use the property's own reference
  currency; cashflow entries keep theirs, and no figure is ever converted.
  - *net invested capital* — acquisition price + cumulative operating expenses −
    cumulative operating income (rents already deducted, financing excluded). It reads
    **unknown** when the acquisition price is missing or when the cashflow totals are
    in another currency than the prices; never a zero.
  - *outstanding debt* — the recorded loan balances in the property's price currency.
    A property without loans has a known debt of 0. One loan without a recorded balance,
    or in another currency, makes the total unknown: partial sums understate the debt,
    and conversion would invent a rate.
  - *break-even sale price* — net invested capital + outstanding debt, **excluding
    selling costs** (unknown before the sale). Selling at this price would repay the
    capital left in the property and its debt.
  - *target sale price* — break-even price + target margin × net invested capital. The
    margin is stored per property (`targetGainRate`, 10 % by default, 0–100 %). A
    non-positive net invested capital uses a zero base, so the target is the break-even
    price instead of a lower figure derived from a negative base.
  - *estimated equity* — the latest append-only valuation − outstanding debt, only
    when both figures are known in the same currency. With no valuation, an unknown
    debt, or a currency mismatch it reads **unknown**, never zero. *Estimated gain* —
    estimated equity − net invested capital, before selling costs. A dated entry is
    required for the legacy single-value form; history rows carry their own valued-on
    date, amount, explicit currency and optional source note. New rows are append-only
    so prior valuations remain auditable; currencies are never converted.
  - *gap to target* — target price − estimated value; positive means the target is still
    ahead. The status is one of: sold, no estimate, unknown (a missing input), below
    target, target reached — printed literally, never inferred from a zero.
  - *recorded sale* — a sale is a dated event, not a deletion: the property keeps its
    cashflows, loans and history. *net proceeds* = sale price − selling costs −
    outstanding debt; *gain* = net proceeds − net invested capital. The three sale
    fields are asked together (costs may be 0), so a sale recorded through this flow
    always carries its price; a legacy date saved without one reads « prix non
    renseigné » and can be completed from the detail page. A gain that cannot be
    computed reads unknown with its reason.
  - *history* — purchase, cashflows (settled date, else due date, else creation date),
    loan starts, valuation and sale, most recent first. A cashflow linked to a
    transaction carries the **transaction's** amount, like the totals, so the history
    and the figures can never disagree.
- Property performance indicators (property detail, « Indicateurs de performance »,
  RE-03) — `computePropertyKpis`, a pure function of the property's cashflow entries,
  loans and one explicit window. No market benchmark is read and nothing is extrapolated.
  - *window* — always twelve whole months, so a sum over the window is an annual figure
    and a yield needs no annualisation. Two windows are offered: the twelve last months
    (`?period=trailing`, the default, current month included) and a calendar year
    (`?period=YYYY`, offered only when something is dated in it). A malformed, pre-1970
    or future value falls back to the rolling window instead of failing the page. The
    bounds are `start` inclusive and `end` exclusive, so one entry belongs to exactly one
    window.
  - *dating* — an entry is placed by its settlement date, else its due date, else its
    creation date (`cashflowEntryDate`), the rule the history already uses, so the two
    can never place one entry in different periods.
  - *currency* — the reference currency is the property's price currency. An entry in
    another currency is excluded and counted, never converted; the yields read unknown as
    soon as the window holds one, because the sums would then describe only part of the
    rent. Loan currencies follow the same rule.
  - *rental income* — the INCOME entries dated in the window; *operating expenses* — the
    EXPENSE entries, reported as a positive number. A transaction-linked entry is resolved
    once (`resolveCashflowAmount`), exactly like the property totals, so no money is
    counted twice. An entry with neither an amount nor a transaction is excluded and
    counted rather than failing the card.
  - *NOI* — rental income − operating expenses.
  - *financing cost* — monthly payment + insurance of each loan, multiplied by the months
    the loan is active inside the window (monthly granularity: a loan started mid-month
    costs a full month). A loan repaid before the window costs nothing; a loan without a
    start date is counted over the whole window and says so. A loan in another currency,
    or one recording neither payment nor insurance, makes the cost **unknown** — never a
    partial sum, never a zero. Financing is read from the loan records only: a loan
    instalment must not be entered as a property cashflow.
  - *cash flow after financing* — NOI − financing cost; unknown as soon as the financing
    cost is.
  - *gross yield* — rental income ÷ acquisition price, in percent; *net yield* — NOI ÷
    acquisition price. The denominator is the acquisition price, never a valuation, and
    the numerator is not annualised: both read unknown when the acquisition price is
    missing, when the window is the calendar year still running (a partial year is not
    extrapolated), when the window holds no cashflow, or when it holds a foreign-currency
    one.
  - *occupancy* — the property's declared `PropertyOccupancy`, shown beside the one signal
    that is measurable today: the number of months with at least one recorded rent. There
    is no lease table, so neither the declared status nor the absence of rent is turned
    into an occupancy *rate*.
  - *no data* — a window without a single cashflow computes no figure at all and the card
    says so, instead of printing a grid of zeros. A property with recorded expenses but no
    rent does show a real rental income of 0, with its months-with-rent count beside it.
- GitHub issues — only **open** issues and pull requests are kept, and only the
  fields needed to act: title, link, author, **assignees**, **milestone**, comment
  count, labels, dates. No description, no comment body, no source code: reading them
  stays at the provider.
  - `recent` — opened less than 14 days ago, whatever the kind.
  - `unanswered` — an *issue* (not a pull request) open for at least 3 days with
    zero comments. This is the signal that goes unnoticed in a busy repository.
  - `pullRequests` — open pull requests, counted apart: they are review work, not
    reports.
  - `stale` — an issue open for at least 90 days. Reported, never judged: a
    long-lived issue may be a deliberate plan.
  - `oldestOpen` — the oldest open issue, with its age in whole days.
  A closed issue leaves the list at the next synchronisation, which is what keeps
  it a to-do list rather than an archive.
- Issues per repository — `summariseByRepository` counts each repository's open
  issues, pull requests, new entries and unanswered entries, and is never truncated:
  the flat list is capped for readability, a repository is not. Focusing one
  repository (`?repo=owner/name`) recomputes every indicator on that repository
  alone, so the figures always describe the rows displayed beside them. The wording is
  literal: the list is rendered by the explorer below.
- Issue explorer — filters combine as an intersection (`filterIssues`): repository,
  kind, assignee (including "personne"), label, milestone (including "aucun"), flag
  (`sans réponse`, `ouverte récemment`, `ancienne`, `sans assigné`), title search, and
  sort (recent, oldest, comments, activity). The flags reuse the very predicates that
  draw the badges, so a filter and a badge can never disagree. The controls are built
  from the values actually present in the data, and a value that no longer exists is
  ignored rather than applied: a filter that matches nothing while its select shows
  "Tous" would be a screen that lies.
- Milestones — `listMilestones` keeps the provider's counters and due date, plus the
  number of issues followed here and how many of those have no assignee. The card names
  both figures because they differ: the provider counts everything attached to the
  milestone, this dashboard counts what it stores. `describeMilestoneDue` never calls a
  closed milestone late — its due date is history, not a warning.
- Work queue (integrations page, « File d'attente », DA-01) — the actionable view: what
  needs a decision now, computed **only from the issues and milestones already stored**
  (`buildWorkQueue`, a pure function of the rows and a clock). It reuses the very
  predicates the explorer and the badges use, so a queue rule and a badge can never
  disagree, and it reads the **same filtered set** as the explorer, so both views
  describe the same selection. An issue may appear in several buckets — each is a
  distinct reason to act. Each bucket is sorted by « Ouverte depuis », smallest lapse
  first (most recently opened first), by default; the column headers (Sujet, Assigné à,
  Ouverte depuis) switch the column and direction through `?queueSort=<column>.<asc|desc>`.
  Ties fall back to repository and number, so the order is stable; an unassigned item
  sorts as an empty name:
  - *Sans réponse* — an issue open for at least 3 days with zero comments
    (`isUnanswered`, the same rule as the "Sans réponse" badge).
  - *Pull requests anciennes* — an open pull request at least 14 days old
    (`DEFAULT_OLD_PULL_REQUEST_DAYS`). Reported, never judged: an old PR may be a
    deliberate wait.
  - *Issues sans jalon* — an issue with no milestone (a pull request is not listed here:
    the rule is about issues).
  - *Sans étiquette* — a row with no label at all: no nature, no priority signalled.
  - *Travaux bloqués* — a row whose labels include one of `BLOCKED_LABELS` (« blocked »,
    « bloqué », « on hold », « waiting », « en attente »…), matched case-insensitively.
    The convention is a documented constant, not a per-owner setting.
  - *Jalons à échéance* — open milestones that are overdue or due within
    `DEFAULT_MILESTONE_DUE_SOON_DAYS` (7) days, split into the two, soonest first. A
    closed or undated milestone never appears, exactly as `describeMilestoneDue` reads it.
  **Review state is deliberately absent.** Whether a pull request awaits review (draft
  flag, requested reviewers, review decision) is not in the issues payload this
  integration reads; obtaining it would need a separate bounded `/pulls` call. DA-01
  makes no such call: the queue signals old pull requests by their age and says so in
  the card, rather than inventing a review state it cannot know. An issue with no
  milestone or no label is a real state, never a zero; a milestone without a due date is
  never "due soon".
- Activity metrics (integrations page, « Indicateurs d'activité », DA-02) —
  `buildActivityMetrics`, a pure function of the stored snapshots and a reference
  instant `now` (the render time): the same rows and the same `now` give the same
  figures. They read **every stored row**, not the explorer's filtered selection. The
  card only appears once a connection has synchronised at least once, and it names the
  last read. They describe a backlog and are never a measure of people.
  - *Pull requests ouvertes* — the number of stored `PULL_REQUEST` rows, i.e. open at the
    last synchronisation. Unavailable (not zero) when no connection reads pull requests
    (GitLab does not today).
  - *Âge médian des PR ouvertes* — the median of `floor((now − openedAt) / 1 day)` over
    those rows; the mean of the two middle values for an even count. No open pull
    request means no median ("—"), not an age of zero.
  - *Dépôts inactifs* — a stored project whose last provider-reported activity is at
    least `DEFAULT_INACTIVE_DAYS` (30) whole days before `now`. The window is that
    threshold. The source differs per provider and is not the same signal: GitHub
    `pushed_at` (last push, any branch), GitLab `last_activity_at` (also moved by issue
    and merge request activity). A project without a usable date is listed as
    *inconnue*, never counted as inactive or active. The table lists inactive and
    undated repositories, sorted by « Dernière activité », smallest lapse first, by
    default; its headers switch to the repository name or the other direction through
    `?activitySort=<column>.<asc|desc>`. An undated repository always sorts last: an
    unknown date is not "the oldest".
  - *Avancement des jalons ouverts* — over open milestones only, the provider's closed
    counters divided by its open + closed counters (the same counters as the milestones
    card, which cover items not followed here). No item attached to any open milestone
    means no figure ("—"), not 0 % or 100 %.
  - *Délai ouverture → fusion* and *débit d'issues* — **unavailable, by decision.**
    Snapshots keep open issues and pull requests only, and a row that disappears may
    have been closed, merged, transferred or have left the bounded fetch; there is no
    `mergedAt` and no closed history to compute either honestly. Providing them needs
    an additive, bounded fetch of recently closed items (new fields or a table, a
    migration and more provider quota) — a separate ticket, not part of DA-02.
- Repository health (integrations page, « Santé des dépôts », DA-05) —
  `buildRepositoryHealth`, pure functions over the stored projects and milestones and a
  reference instant. Each indicator states its rule on screen and lists the repositories
  it flags, linked to the provider; there is no global score and nothing implies a
  write. A repository is **flagged**, **fine** or **not evaluated** (with the reason) for
  each indicator, and "not evaluated" is never counted as fine:
  - *Dépôts inactifs* — the activity metrics rule, reused rather than restated
    (`projectLastActivity`, `DEFAULT_INACTIVE_DAYS` = 30), listed from the shortest to
    the longest inactivity, so the repositories that just went quiet lead. Every other
    indicator lists its repositories by name.
  - *Backlog d'issues* — the provider's open issue counter is at least
    `DEFAULT_BACKLOG_THRESHOLD` (25). The provider counter is used rather than stored
    rows because issues are only stored for the bounded selection, and only on GitHub.
    GitHub's counter includes pull requests, and the text says so. GitLab lists
    projects with `simple=true`, which carries no counter, so the indicator is not
    evaluated there. DA-02 defines no issue backlog figure (only pull request counts),
    so there was none to reuse.
  - *Jalons en retard* — at least one open milestone past its due date, read exactly as
    `describeMilestoneDue` reads it (a closed or undated milestone is never late). Only
    evaluated where milestones are read: GitHub, and repositories inside the bounded
    selection, computed with the adapter's own `selectRepositoriesToScan` per connection.
  - *Sans description* / *Sans topics* — the repository has no description, or no topic.
  - *Métadonnées manquantes* — no default branch, which usually means an empty
    repository.

  Repositories an indicator cannot judge are grouped by reason (`groupUnavailable`):
  each reason is stated once, followed by the repositories it concerns, rather than
  repeated after every one of them.

  **Storage decision:** description and topics were not stored. They are already in
  the project listing both providers return, so they are kept in the existing
  `ProjectSnapshot.metrics` JSON as `hasDescription` (boolean) and `topicCount`
  (number) — no migration, no extra request, and only the *presence* of a description,
  never its text. A key the payload did not carry is stored as `null`; a snapshot taken
  before this change has no key at all; both render "not evaluated", and the next
  synchronisation fills them. GitLab falls back to `tag_list` on instances older than
  `topics`.
- Budget charts — two, each answering a question the monthly table cannot. Both reuse
  the aggregation rules above instead of defining their own, so a number in a chart
  always equals the same number in a table:
  - *Trend over 12 months* — one point per month ending on the selected month, income
    above the axis and expenses below, with the monthly net printed above each column.
    Transfers count by their sign, like the totals above. Months without data are drawn as
    zeros rather than skipped, so a gap reads as "nothing recorded" and the time axis keeps
    its scale.
  - *Where the money goes* — the selected month per category, largest first, with each
    share of the total. `EXPENSE` by default, `INCOME` through `?breakdown=INCOME`. A
    refund reduces its category, exactly as it reduces the monthly total, so a category
    can legitimately be negative. Transactions without a category keep their own
    "Sans catégorie" line, and transfers a "Transferts entre comptes" line rather than
    being merged with them: a transfer has no category by design. Dropping either would
    make the bars fail to add up. The
    smallest categories are merged into one "Autres" line once the row budget is
    reached, and the total stays exact.
- Prévisions chart — *the month's balance, day after day* (« Prévisions » tab), **three
  lines** on one axis:
  - *solde enregistré* — the currency's balance strictly before the month, advanced by each
    recorded operation;
  - *échéances du mois* — the month's undecided movements as their own cumulative from zero
    (their weight so far, not a balance);
  - *simulé cumulé* — **report simulé** + recorded + échéances, i.e. the simulated balance
    the six-month schedule shows, accumulated day by day.

  The **report simulé** is what the simulation had already counted and the ledger never
  received: the previous month's undecided échéances and its simulated (unbooked) salary.
  Without it the simulated line would restart from the recorded balance every month and
  silently drop the month before; a decided occurrence or a booked salary is a recorded
  operation and is therefore never carried a second time. It covers the **immediately
  preceding month** only — bounded and predictable; chaining further back would need a
  documented start of the simulation. The **six-month schedule starts from the same
  carried report**, so the chart's last point and the schedule's row for that month give
  the same simulated balance (`projection.test.ts` guards the invariant).

  The gap between the recorded line and the simulé cumulé is exactly what waits for a
  decision, so a projection is never drawn as money. A movement dated outside the month is
  refused rather than drawn on another day; one point per calendar day, empty days
  included; the start, the carried report, both month-end figures, the échéances total and
  the lowest point of the simulé cumulé are printed under the drawing. The legend is
  interactive: each line can be hidden on its own (hiding two isolates the third), the axis
  rescales to the lines still shown, and the tooltip lists only those; « Tout afficher »
  restores all three. Hidden state is per chart and never stored. A currency nothing
  was ever recorded in has no balance to draw (a currency with in-month operations only
  starts at zero, like the six-month schedule); a truncated window read hides the chart
  instead of showing a partial curve. The series is built by `buildDailyBalance`
  (`modules/budget/evolution.ts`).

The Prévisions chart is the one **client-side** chart: it uses the shadcn/ui chart
primitives (`components/ui/chart.tsx`) on top of Recharts, with a step line per series,
tooltips and a legend. The trade-off, accepted deliberately: it adds a client bundle and
hydration where the rest of the dashboard has none, in exchange for a conventional,
interactive chart. The numbers it draws are still computed on `Decimal` server-side and
sent as plain numbers; only formatting happens in the browser, and the exact figures
remain printed under the drawing. The two other budget charts (trend, category breakdown)
stay plain server-rendered SVG with no dependency.

An indicator is only displayed once its definition is written down, which is
what this section is for.

## Alert engine (BP-05)

Alerts are **observations** about the owner's own data, produced by deterministic
rules: a threshold, a comparison, an explanation. No rule writes to the ledger, and
no machine learning or statistical heuristic runs in this first pass. The rules live
next to what they read — `budget/alerts.ts` (low balance, budget overrun, budget
threshold, unusual expense), `integrations/alerts.ts` (stale synchronisation),
`real-estate/alerts.ts` (overdue event) — and every one of them is a pure function of
its inputs and a clock, so a fixed date is enough to test it.

The engine runs **server-side on demand**: the dashboard and the alert page each call
one bounded evaluation pass while rendering (accounts with grouped balances, the
month's budgets and transactions, the connections, the due cashflows, the stored
episodes). Nothing runs in the background, and a read that could be partial — the
month series hitting its row bound — makes the rules that depend on it stay quiet
rather than accuse on half-read data.

**What triggers, exactly** (boundaries included):

- *Low balance* — the recorded balance of an account is **strictly below** the
  threshold (exactly at the threshold is not below it). An account with no recorded
  transaction is not at zero: its balance is unknown and the rule leaves it alone. A
  zero threshold applies in every currency (zero reads the same everywhere) and flags
  overdrawn accounts; a positive threshold only compares accounts in its own currency,
  because nothing is ever converted.
- *Budget overrun* — an **expense** row of the Suivi report is exceeded (`actual >
  planned`) and the overrun reaches the configured margin: the margin is compared on
  the exact percentage of the planned amount (default 0 → any overrun). Income targets
  are never "overrun". Refunds, transfers and uncategorised lines follow the Suivi
  rules, and rows in another currency are never mixed in.
- *Budget threshold* — the preventive companion of the overrun, never a second voice on
  the same situation: an expense row has reached the configured share of its planned
  amount (default 80 %) **without being exceeded yet** (`overrun ≤ 0`, so exactly 100 %
  still counts). The moment the first euro goes over, the threshold episode resolves and
  the overrun alert opens. A refund-dominated envelope (negative actual) never fires it,
  a month read in part stays silent like the overrun rule, and an untouched envelope does
  not fire even a zero threshold.
- *Unusual expense* — a single **expense** of the current month reaches or exceeds the
  threshold, in its currency. This is a fixed amount threshold, not an anomaly score.
  Transactions carrying an `externalRef` (a confirmed prévision, a salary booking) are
  excluded: machine-booked lines are expected by construction.
- *Stale integration* — the last successful synchronisation is older than the
  configured number of days (exactly the threshold old is not stale). A connection
  that never synchronised is not "stale": its data is missing, and the Integrations
  page already says so.
- *Overdue event* — a property cashflow has a due date in the past and is not settled
  (`isCashflowOverdue`, the same reading the real-estate page shows), and it is late by
  **more** than the grace period (grace 0 → the day after the due date). An unresolved
  entry still counts; its reason then says "montant inconnu" instead of a figure.

**Duplicates and the lifecycle.** Each alert carries a fingerprint — rule + entity +
period — unique per owner, which is what suppresses duplicates: re-evaluating the same
condition refreshes the episode (`triggeredAt` untouched, inputs and `lastSeenAt`
moved) instead of stacking a second row. A dismissed alert stays dismissed while the
condition holds; when the condition disappears the episode **resolves**, and if it
triggers again later the row **reopens** as a fresh episode. Disabling a rule closes
its open episodes the same way, so re-enabling it asks anew.

**What is stored is not the sentence.** A row keeps its message *inputs* as plain
strings — amounts, names, dates, computed gaps — and the French reason is recomputed
from them at render time. A forged request can therefore never write the text a page
shows, and wording changes never need a migration. Rule configuration is one row per
kind (`AlertRule`); a missing row means defaults, amounts always name their currency
so nothing is converted, and the settings form spells out each rule's semantics
beside its fields.

## Security model

- Single owner, credentials hashed with bcrypt, Auth.js session as a signed JWT.
- Every private page, Route Handler and Server Action re-checks the session
  server-side. A valid signature is not enough: the owner row is looked up too, so a
  session that outlives a recreated database is treated as signed out (redirect to
  the login page) rather than letting the owner reach pages that read nothing and
  writes that fail on a foreign key.
- Workspaces: every session resolves exactly one active workspace (`SessionUser.workspace`,
  with the role held there) from the user's own memberships, server-side only. A user
  without any membership is refused like a signed-out one, and a workspace id the user
  is not a member of reads as "not found". The migration gives each existing user a
  personal workspace (`ws-<userId>`) as `OWNER`.
- Record scoping (M7-04): budget, real-estate, integration and alert records carry a
  `workspaceId`, and every repository function takes the active workspace's id
  (`user.workspace.id`) and filters on it — exports included. A foreign workspace's row
  reads as "not found". Unique constraints carry the workspace dimension (for example
  the alert `fingerprint` and the budget (category, year, month, currency) tuple).
  Child rows (loans, cashflows, snapshots, cache entries, sync runs) are scoped through
  their property or connection. See [workspace-scoping.md](workspace-scoping.md) for the
  migration and its rollback.
- Modules: the keys of `src/modules/catalog/catalog.ts` are the only ones accepted
  (`budget`, `real-estate`, `development`, `ai-costs`, `agents`, `micro-business`,
  `profitability`, `automation`, `family`). A module is active in a workspace when its
  `WorkspaceModule` row is enabled and all its prerequisites are active
  (`profitability` needs `budget` and `real-estate`). The module's Server Actions call
  `requireModule(key, permission)`, which answers 404 otherwise; its exports answer a
  404 JSON body when the module is disabled and a 403 JSON body when the role lacks the
  permission. Its pages check `hasModule` and render `ModuleDisabled` instead (a direct
  link explains the state and reads nothing). The navigation is built by the server
  layout from the active modules. Disabling only flips `enabled`: records and
  configuration stay.
  Enabling writes the activation row only. The migration enables `budget`,
  `real-estate` and `development` on every existing workspace. The dashboard, the alerts
  and the account page are not modules, but the dashboard reads and shows only the
  sections of active modules, and the alert page, banner and export hide the alerts of
  inactive ones (`ALERT_KIND_MODULES`; the stored episodes are left untouched). The
  `/modules` page lets an `OWNER` or `ADMIN` enable or disable the modules that have a
  page, with their prerequisites and what disabling hides.
- Provider tokens are encrypted at rest (AES-256-GCM, key from the environment)
  and never returned to the browser; only `hasStoredToken` is exposed.
- Provider permissions are read-only; the adapters expose no write operation.
- Exports are `no-store`, authenticated, owner-scoped and bounded, and CSV values that
  could be read as a spreadsheet formula are neutralised (see **Exports**). Every
  delivered file writes one audit entry; a file whose entry cannot be written is
  withheld.
- Personal data is never placed in fixtures, screenshots or logs. Error messages
  persisted for display contain a code, never a token or a payload.

## Responsive, dark mode and installability (UX-03)

- **No service worker, no offline cache.** The app is installable through
  `src/app/manifest.ts` and the icons in `public/icons/` only. Pages, RSC payloads and
  API responses hold personal financial data and are never stored for offline use;
  the `no-store` exports are unaffected. Adding a service worker later needs its own
  decision and a whitelist of static assets only (`/_next/static`, `/icons`), never
  HTML, RSC or `/api`.
- The proxy matcher leaves `manifest.webmanifest` and `/icons/` public, like the
  favicon: the browser fetches them without the session cookie, and they contain no
  personal data. Every other path still requires a session.
- The theme follows `prefers-color-scheme`; `color-scheme: light dark` makes native
  controls (date pickers, selects, scrollbars) follow it too, and `theme-color` matches
  the page background of each theme.
- `prefers-reduced-motion: reduce` disables every transition and animation
  (`globals.css`).
- Contrast: `src/components/contrast.test.ts` computes the WCAG ratio of the text and
  background pairs of the interface, in both themes, from Tailwind's own colour tokens,
  and requires 4.5:1.
- Wide tables keep a minimum width and scroll horizontally inside their card
  (`overflow-x-auto`), so the desktop spreadsheet layout is not squeezed on a phone.

Manual checks (fictitious data only):

| Check | Status |
| --- | --- |
| Manifest, icons and `theme-color` served signed out; private pages still redirect | Done (curl, 2026-10-22) |
| Dashboard, budget (Opérations, editable table), real estate, alerts at 375 px wide, both themes | To do |
| Installation from Chrome / Edge, then « Ajouter à l'écran d'accueil » on iOS | To do |
| Reduced motion enabled in the OS: folding chevrons no longer animate | To do |

## CSV import of bank statements

The « Importer un CSV » page (`/budget/import`) is the deliberate manual alternative to a
bank connector, which stays out of scope. The file **never leaves the browser**: it is
read with `File.text()` and parsed locally by the pure helpers of
`src/modules/budget/import.ts` (RFC 4180 essentials — quoted fields, escaped quotes,
CR/LF, BOM, delimiter detection), the owner maps the columns on a preview, and only the
normalised rows are submitted to a Server Action, which validates every field again — a
browser preview is a comfort, never a permission.

Rules, in one place:

- **dates**: `YYYY-MM-DD`, or day-first French forms (`DD/MM/YYYY`, `DD/MM/YY` → 20YY,
  `DD-MM-YYYY`, `DD.MM.YYYY`). Month-first forms are deliberately not guessed;
- **amounts**: one signed `Montant` column, or a `Débit`/`Crédit` pair
  (`credit − debit`); accounting parentheses `(45,90)` mean negative; a zero amount is
  refused (nothing to record);
- **direction**: the sign decides — negative becomes an `EXPENSE`, positive an `INCOME`.
  An import never creates transfers;
- **currency**: the destination account's, never the file's — the currency is never
  asked twice;
- **categories**: matched by exact name among the owner's categories of the matching
  kind; unknown names leave the row uncategorised and are counted in the summary, never
  invented;
- **duplicates**: *same operation date, same label (whitespace collapsed), same amount*
  — checked against the account's stored rows and within the file itself, only when the
  owner ticks the box. A mapped reference column is stored as `externalRef =
  import:{ref}`, so re-importing the same export keeps skipping the same lines even after
  a label was corrected;
- **bounds**: at most 2 000 rows per import (the page cuts and says so), a 2 MB file
  limit, and the duplicate check reads at most 20 000 existing rows in the file's date
  window — past that the import is refused with an explanation rather than checked
  partially. Only active accounts can receive an import.

## Exports

Five CSV exports leave the application. Each entity keeps its own Route Handler, and the
umbrella `/api/export?entity=...` selects the same builder, so both entry points share
the guards, the columns, the row bound and the audit entry:

| Route | Module | Filters |
| --- | --- | --- |
| `/api/export/transactions` | `budget` | `from`/`to`, `month` (default), `year`, `all=1`, `account`, `category`, `type`, `q`, `reconciled` |
| `/api/export/properties` | `real-estate` | `from`/`to` on the acquisition date |
| `/api/export/budgets` | `budget` | `from`/`to` (whole months) or `month` (default) |
| `/api/export/goals` | `budget` | `status`, `from`/`to` on the target date |
| `/api/export/alerts` | none (module-filtered) | `status`, `from`/`to` on the trigger instant |

They share the same guards: `requireApiUser()` first (401 JSON, no read), the owner
coming from the session and never from the query string, `Cache-Control: no-store`, and
every value passing through `toCsv` in `lib/csv.ts` — a cell starting with `=`, `+`, `@`
(or a number-compatible minus sign) is neutralised, while a plain negative amount such as
`-350.00` stays a number.

`entity` is a closed code from `EXPORT_ENTITIES`, never a path or a table name: a missing
or unknown value, including `all`, answers 400 with the supported list before any read.
The dispatch is a `switch` over that union, so no query string reaches a read outside the
catalogue.

### Date and entity filters

`from` and `to` are `YYYY-MM-DD` calendar days, both **inclusive**; internally the read
uses an exclusive upper bound (`to` + one day), the convention every other query uses. A
missing side is unbounded — `?from=2026-01-01` reads everything after that day.

A malformed day, an impossible one (`2026-02-31`) or `from > to` answers 400
(`invalid_export_filter`) instead of falling back: a `month` link with a typo may fall
back to the current month, but an explicit window must be honoured or refused, never
quietly replaced by a different period. When a window is present it wins over `all`,
`year` and `month`.

The bounds apply to the entity's own date: the operation date for transactions, the
acquisition date for properties, the target date for goals and the trigger instant for
alerts. A budget is stored per month, so its window selects **whole months**
(`from=2026-02-15&to=2026-04-02` reads February to April). Alerts are instants and a URL
carries no time zone, so those bounds are UTC days. A property without an acquisition
date is absent from a windowed file: it cannot be said to belong to the period.

Two conventions of the data apply to the files. An **unknown value is an empty
cell**, never a zero: a goal whose amount cannot be read exports blank numeric
columns plus the reason in its `note` field. **Instants are ISO 8601 in UTC** (the
alerts export), since a file loses the display time zone; calendar days stay
`YYYY-MM-DD`. The transaction export carries the reconciliation day in its own
`pointe_le` column — an empty cell is "not checked yet", a state, not a missing date.

### Row bound, truncation and memory

Large exports are **bounded, not streamed**: every read asks for `EXPORT_ROW_LIMIT + 1`
rows (10 001) and the file carries at most `EXPORT_ROW_LIMIT` (10 000) plus its header.
The extra row is never written — its presence sets `X-Export-Truncated: true`, because a
spreadsheet cannot tell a complete file from a prefix. The response is one SQL read and
one in-memory string, a few megabytes at this cap. Past it the right answer would be a
cursor and a chunked response; the header is what makes the cut visible until then. The
single-month budget export is bounded by its own shape (one row per category and
currency).

### Audit of exports (SO-02)

Every delivered file writes one `AuditEvent` row: the workspace, the actor, the action
code (`export.transactions`, `export.properties`, `export.budgets`, `export.goals`,
`export.alerts`), `entityType: "EXPORT"`, the outcome, and metadata limited to the
resolved scope, the bounds, the row count and the truncation flag. Metadata passes
through `redactAuditMetadata` (`src/modules/audit/domain.ts`), which drops a sensitive key
outright (`token`, `email`, `label`, `amount`, …) and replaces free text with
`[redacted]`, so the trail never becomes a second copy of the ledger.

The entry is written after the read and **before** the response: a failed write answers
500 and withholds the file, because an export the trail does not know about is worse than
an export delayed by a database error. Nothing in the application exposes an update or a
delete of `AuditEvent`, so the trail is append-only in practice, not only by convention.

A refused export — an invalid window or an unknown `entity` — is not recorded: it reads
nothing, and logging every malformed link would let a client fill the trail. The
vocabulary reserves `REFUSED` and `FAILED` for writers that modify data and must state
that they did not.

Retention: rows are **not pruned yet**. They are cheap (codes, counts and calendar days,
no payload), and their bound belongs to the retention work of M18, which will reuse the
cutoff helper already used by `SyncRun` (`src/jobs/retention.ts`). Until that job exists,
a manual `DELETE` scoped by `workspaceId` and `createdAt` is the documented procedure.

## Synchronisation

`synchroniseConnection()` performs one run: it loads the connection, decrypts
the token, calls the provider adapter and upserts the snapshots. It is
idempotent — snapshots are keyed by `(connectionId, externalId)`.

There is no permanent loop in the web process: a run is triggered by a scheduler
outside it (see `README.md`). A manual "Synchroniser" button calls the same
function for convenience.

A failure keeps the previous `lastSyncedAt` and stores a safe error code, so the
interface can show "synchronisation failed" instead of an empty dashboard.

### Run history, freshness and retention

Every attempt that starts is recorded as a `SyncRun` row and closed in every outcome:
`SUCCESS`, `PARTIAL` (some repositories were left unread — by the run bound or a
provider refusal) or `FAILED`. `fetched`, `created` and `updated` count provider items
and snapshot rows; `skipped` and `failed` count repositories, the unit the run bound
and provider refusals operate on. Only safe error codes are stored, never a token or a
response body.

Transient failures are retried with bounded backoff (network errors, HTTP 429,
HTTP 5xx, and a spent GitHub quota reported as 403): three attempts by default, a
capped wait, and the provider's `Retry-After` honoured unless it exceeds the cap.
Authentication, permission and not-found refusals are never retried. The retry count
is stored on the run and displayed with it.

Freshness: a successful synchronisation older than 24 hours (`STALE_AFTER_HOURS`) is
displayed as stale, on the integrations page and on the dashboard. An empty success
reads "réussie — rien à lire", not a quiet success, and a `RUNNING` row left behind by
a stopped process reads "interrompue" rather than "en cours".

Retention: run history is kept for 90 days (`SYNC_RUN_RETENTION_DAYS`), with the most
recent successful run of each connection always retained so freshness survives a long
pause. `npm run db:cleanup` applies the policy — bounded, owner-scoped, safe to re-run
and never scheduled from the web process. Snapshots are current state rather than
history: a run replaces them, so they are not subject to this retention.

### Issues: an explicitly bounded run

A run also fetches the open issues and pull requests of the tracked repositories,
for the providers that expose them (GitHub; see the GitLab adapter for why it is
deliberately excluded). Issues cost one request per repository, so the run is
bounded on purpose: repositories are ordered by recent activity and only the most
recently pushed ones are queried, with a fixed page size each. A repository that
was not read is reported as such after a manual run — never as "nothing is open".

Milestones are read from the same repository selection, one more request each, so the
issue list and the milestone list always describe the same scope.

A single unreadable repository (renamed, moved, deleted) is counted and skipped:
it must not cost the others. A quota or a revoked token fails the whole run
instead, because a partial issue list would look complete.

Closed issues are deleted at the next run **per repository read in full**: the issues
of that repository the provider no longer reports as open go, and every issue of a
repository that is no longer tracked goes too. A repository answered 304, skipped by
the bound or refused by the provider keeps its rows — they are current (304) or
unknown, never "closed". Milestones follow the same rule.

### Conditional requests (DA-04)

The per-repository issue and milestone requests are **conditional**: the validators
GitHub returned last time (`ETag` → `If-None-Match`, `Last-Modified` →
`If-Modified-Since`) are sent back, and a `304 Not Modified` means the stored rows of
that repository are current. They are then neither re-normalised nor rewritten; only
the check is recorded. GitHub does not count a 304 against the primary rate limit,
which is what makes frequent runs cheap. The fetch bounds are unchanged.

Validators live in `ProviderCacheEntry`, one row per connection and resource, keyed by
`cacheResourceKey` = cache version + exact request URL. They are a separate table
rather than fields on the snapshot tables because the cached resource is a *list* per
repository, which may have no snapshot row at all (a repository with no open issue).
No payload is cached: the rows stay in the snapshot tables. Each entry carries two
instants, displayed in « Requêtes conditionnelles » on the integrations page:
`checkedAt` (last successful check, 200 or 304) and `changedAt` (last time its rows
were written from a full answer).

Validators never vouch for data that is not there:

- They are stored **after** the rows they describe (`saveCacheChecks` runs once
  `saveIssues` / `saveMilestones` returned). A run that fails halfway keeps at worst an
  old validator for old rows.
- A full answer replaces the validators, with nothing when it carried none or carried
  a malformed one, so a stale validator is never kept. A repository whose answer failed
  normalisation records no check at all.
- A 304 to a request that sent no validator is an invalid response, not "unchanged".
- Stored metadata that is malformed is not sent, and an entry whose rows were last
  written more than `CACHE_MAX_AGE_DAYS` (7) days ago is **expired**: no validator is
  sent and the resource is read in full, so every resource is re-read at least weekly
  whatever the provider says. The page shows such an entry as expired, not current.

Invalidation:

- *Connection removal* — entries cascade with the connection.
- *Token change* — saving a connection (`upsertConnection`) deletes its entries: a new
  token may see other repositories, and GitHub validators depend on the credentials.
- *Bounds change* — the request URL carries `per_page` and the filters, so a changed
  bound produces a new key and the old validator is never matched; the orphaned entry
  stops being checked and is dropped after `CACHE_MAX_AGE_DAYS`.
- *Schema or normalisation change* — bump `CACHE_VERSION`: every key changes and the
  next run reads everything in full.
- *Repository no longer tracked* — its entries are dropped at the next run.

Not conditional: the project listing (paginated and sorted by last update, so a page's
validator says nothing about the next page, and pruning projects needs every page),
and GitLab (only its project listing is read).

Cache validators are not secrets — they are opaque tags of public-to-the-token
responses — but they are still read and written server-side only, scoped through the
owner's connection.

### CI status (DA-03)

GitHub Actions runs are read from the **same bounded repository selection** (at most
20 repositories, most recently pushed first), with one request each:
`GET /repos/{owner}/{repo}/actions/runs?per_page=20`, newest first. A run therefore
costs at most 20 more requests on top of projects, issues and milestones — well under
the hourly quota of an authenticated token. No other endpoint is called: no jobs, no
logs, no timing, no re-run (the integration stays read-only; re-running happens on
GitHub).

The token needs read access to Actions (`actions:read` on a fine-grained token; a
classic `repo` token already covers it). Unlike issues, a refused CI read **never
fails the run**: a token may read issues without the Actions permission. A 401/403, a
404 or an unexpected payload is recorded per repository (`ProjectSnapshot.ciError`,
safe code only) and the repository is displayed as *CI indisponible* with the reason.
Only an exhausted quota stops the run, as everywhere else, since every following
request would fail the same way.

Stored per run (`CiRunSnapshot`), and nothing else: workflow name, branch, status,
conclusion, link, start and last-update instants. The card, on the integrations page,
shows the **latest run of each workflow**, most recently started first
(`buildCiOverview`), so the last runs read first; ties fall back to repository and
workflow name. Failures are not sorted to the top: a notice above the table counts the
workflows whose latest run failed, so an older failure stays visible. Outcomes:

- *Échec* — conclusion `failure`, `timed_out` or `startup_failure`.
- *En cours* — any status other than `completed` (queued, waiting, in progress).
- *Autre* — completed but neither success nor failure (`cancelled`, `skipped`,
  `neutral`, `action_required`…), reported as it is rather than counted as either.
- *Réussi* — conclusion `success`.

Duration is `runUpdatedAt − startedAt` for a completed run: wall-clock time from start
to the provider's last update, which includes queueing between jobs — not billed time.
`startedAt` is `run_started_at` (the latest attempt), or `created_at` on payloads
without it. Three repository states are kept apart and none of them reads as green:
*CI indisponible* (read refused), *aucune exécution récente* (read, empty page), and
*not read* (`ciCheckedAt` null: outside the bounded selection). A repository outside
the selection on a later run keeps its last read, displayed with the last read date.

**GitLab pipelines are not read** in this first pass: the GitLab adapter returns
`supported: false`, and the card says how many GitLab projects that leaves out.

Retention (DR-05): CI runs are current state, not history. Each read replaces the
runs of that repository with the page just fetched, a refused read drops them, and
runs of repositories no longer tracked are dropped, so the table is bounded by
construction (repositories read × 20 rows) and `db:cleanup` does not need to touch it.
DA-04 can reuse the adapter method as is: it is a single bounded request per
repository whose result is already normalised to the stored fields.

## Architecture invariants (UX-04)

`src/invariants/` asserts the rules the architecture rests on, each with valid and
invalid states and a negative control that proves the check can fail. The suite is
deterministic (fixed seeds, `seededRandom` in `helpers.ts`), network-free and
database-free, and uses fictitious values only. No property-testing dependency: the
seeded generator is enough, at the cost of no automatic shrinking of a failing case.

| Invariant | Test |
| --- | --- |
| Owner scoping: every repository function opens with a query scoped to `workspaceId` (M7-04) or `userId` | `owner-scoping.test.ts` (fake client records the first queries; exemptions listed with their reason) |
| Exact money, month windows that tile the calendar | `money.test.ts` |
| Cashflow amount XOR linked transaction, counted once | `ledger.test.ts` |
| Transfers count by sign; the volume is a subset, never extra | `ledger.test.ts` |
| Idempotent synchronisation, pruning only after a complete run | `sync-idempotence.test.ts` (real save functions, in-memory tables) |
| Plain DTOs for client forms | `client-boundary.test.ts` |
| No `Decimal` or `Date` in client props; no server-only import in a client module | `client-props.ts` (compile time, `npm run typecheck`) and `client-boundary.test.ts` |

A new repository function must be owner-scoped or be added to `NOT_OWNER_SCOPED` with
its reason; a new `"use client"` file must be added to `ClientModules` in
`client-props.ts`. Both omissions fail the suite.

## System diagnostics (SO-03)

`/diagnostics` (linked from the **Compte** page) answers the operational questions
inside the product, read-only. It calls `requireUser()` first, renders server-side and
is `force-dynamic`; there is no unauthenticated health endpoint.

`src/modules/diagnostics/run.ts` runs the probes, `checks.ts` turns each observation
into `ok | warning | error`, a fixed French message and the action to take. A probe
that fails returns null instead of throwing, so one broken part never hides the others
and no raw error (which could quote a connection string) reaches the page.

| Check | Source | Never shown |
| --- | --- | --- |
| Database | `SELECT 1`, 3 s timeout | the connection string |
| Migrations | failed rows of `_prisma_migrations`; pending = names in `prisma/migrations` (copied into the image) not applied | — |
| Encryption key | presence and `decodeEncryptionKey` validity | the key, even partially |
| Session secret | presence and the `getServerEnv()` length rule | the secret |
| Providers | status, last synchronisation, stored safe error code, instance host | tokens, URL paths |
| Last backup | timestamp in the newest `dashboard-*.dump` **file name** under `BACKUP_DIR` (compose mounts `infra/backups` read-only) | dump contents |
| Version | `package.json`, plus `APP_VERSION` when set (characters `[A-Za-z0-9_.-]` only) | — |

What it cannot see, it says (a warning), rather than reporting a reassuring "ok": a
migration folder or a backup folder that is not visible from the running app. Backup
age is not restorability: that verification is SO-04.

## Not implemented in this base

- No bank connector, no payment, no accounting or tax advice. The CSV import is
  manual and deliberate; nothing polls a bank.
- No writing to GitHub or GitLab.
- Transactions are editable **in place** on the operations table (Enter saves, Escape
  cancels; notes stay in the full form) and creatable, duplicatable and deletable;
  budgets, goals and recurring series can be edited and deleted; accounts can be
  renamed, retyped, archived and restored; categories can be renamed, merged and
  deleted, each with its usage counts shown first. Properties and cashflow entries
  still cannot be edited or deleted from the interface.
- No document/attachment storage.
- The `ai-costs` module ships its money, actuality and source primitives only: no cost
  entry, allocation, import or provider synchronisation exists yet.
- The integrations page triggers a synchronisation on demand; no scheduler entry
  point (cron unit, platform job) ships with the repository yet.
