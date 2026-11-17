# Workspace scoping migration (M7-04)

Migration: `prisma/migrations/20261023100000_scope_records_by_workspace`.

## What it does

For `Account`, `Category`, `Transaction`, `Budget`, `SalarySetting`, `SalaryRate`,
`WorkDay`, `RecurringEntry`, `RecurringOccurrence`, `Goal`, `GoalContribution`,
`Property`, `IntegrationConnection`, `Alert` and `AlertRule`:

1. re-runs the idempotent M7-01 backfill, so every user has its `ws-<userId>` workspace;
2. adds a nullable `workspaceId`, sets it to `'ws-' || "userId"`, then `NOT NULL`;
3. makes `userId` nullable (legacy author column, no longer written or read);
4. replaces each `userId` index and unique constraint by its `workspaceId` twin;
5. adds a foreign key to `Workspace` with `ON DELETE CASCADE`.

No row is inserted, deleted or rewritten beyond the new column. The whole migration runs
in one transaction: a failure leaves the database as it was.

Child tables (`PropertyLoan`, `PropertyCashflow`, `ProjectSnapshot`, `IssueSnapshot`,
`MilestoneSnapshot`, `ProviderCacheEntry`, `SyncRun`, `CostAllocation`) get no column:
they are only reachable through their property, connection or cost entry, which
carries it.

## Verify on a copy before production

Never run it first on the production database. Restore the latest backup into a scratch
database, then:

```sh
# counts and sums, before
psql "$COPY_URL" -Atc 'select count(*), sum(amount) from "Transaction"' > before.txt
DATABASE_URL="$COPY_URL" npm run db:deploy
psql "$COPY_URL" -Atc 'select count(*), sum(amount) from "Transaction"' > after.txt
diff before.txt after.txt   # must print nothing
DATABASE_URL="$COPY_URL" npx prisma migrate diff --from-config-datasource \
  --to-schema prisma/schema.prisma --script   # must print "empty migration"
```

Repeat the count for `Budget`, `Property`, `IntegrationConnection` and `Alert` if
needed. CI applies every migration on a fresh database (`npm run db:deploy`).

## Rollback

Take a backup first; restoring it is the simplest rollback. Without one, while every
workspace is still a personal one (no member added since), this SQL restores the
previous schema. Rows created after the migration have `userId = NULL` and get it
back from the workspace's owner:

```sql
BEGIN;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Account', 'Category', 'Transaction', 'Budget', 'SalarySetting', 'SalaryRate',
    'WorkDay', 'RecurringEntry', 'RecurringOccurrence', 'Goal', 'GoalContribution',
    'Property', 'IntegrationConnection', 'Alert', 'AlertRule'
  ] LOOP
    EXECUTE format(
      'UPDATE %I r SET "userId" = m."userId" FROM "WorkspaceMember" m
       WHERE r."userId" IS NULL AND m."workspaceId" = r."workspaceId" AND m.role = ''OWNER''',
      t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "userId" SET NOT NULL', t);
    -- drops the workspaceId column with its indexes and foreign key
    EXECUTE format('ALTER TABLE %I DROP COLUMN "workspaceId"', t);
  END LOOP;
END $$;
-- then recreate the previous userId indexes and unique constraints, as listed in the
-- DROP INDEX statements of the migration, and delete its row from _prisma_migrations.
COMMIT;
```

Then deploy the previous application version. A second member's rows cannot be rolled
back this way: they would be attributed to the owner.
