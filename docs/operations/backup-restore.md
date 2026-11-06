# Backup and restore

Take a logical backup, prove it restores, and recover a database from one. The scripts
live in `infra/backups/`; this page is the operator procedure. Script internals and the
file format are documented in [infra/backups/README.md](../../infra/backups/README.md).

A dump contains personal financial data. It is git-ignored, excluded from the Docker
build context, and must never be committed, attached to a ticket or pasted into chat.

## What the scripts do

| Script | Effect |
| --- | --- |
| `./infra/backups/backup.sh [output-directory]` | `pg_dump` in custom format, written on the host with a `.sha256` and a `.json` metadata file next to it. Default directory: `infra/backups`. |
| `./infra/backups/verify.sh <dump-file>` | Checks the checksum, restores into a throwaway PostgreSQL container, and writes `<dump>.verification.json` with `"status": "verified"` or `"failed"`. |
| `./infra/backups/restore.sh <dump-file> <target-database>` | Drops and recreates the target database, then restores the dump into it. |
| `./infra/backups/test-backup-cycle.sh` | Automated end-to-end test of the three scripts on a throwaway stack (CI runs it). |

`backup.sh` and `restore.sh` target the compose `db` service by default. Set
`DB_CONTAINER=<name>` to target a throwaway container instead; that is how the restore
rehearsal below stays away from real data. They do not read `.env`: export
`POSTGRES_USER` / `POSTGRES_DB` when they differ from `dashboard`.

## Record the operation in the audit trail

A backup or restore is an operator procedure, not a web action, so the scripts do not
write the trail themselves (they must keep working without Node). Right after a
successful step, record it through the one server-side helper:

```sh
npm run audit:operation -- backup.run SUCCESS
npm run audit:operation -- restore.run SUCCESS
```

Use `FAILED` when the step failed and `REFUSED` when it was deliberately not attempted.
The command writes an action code, an outcome and no path, dump name or database name.
It needs the same server environment as the application (`DATABASE_URL`, `AUTH_SECRET`,
`INTEGRATION_ENCRYPTION_KEY`), and resolves the single workspace; set
`AUDIT_WORKSPACE_ID` only if several exist. Run it from the server's repository checkout
(the database port is published on `127.0.0.1`), not from a machine without those
secrets. The entry is visible on `/audit`, and the operator cleanup keeps it for 365 days
(`AUDIT_RETENTION_DAYS`).

## Take and verify a backup

**Read-only on the database.**

```sh
./infra/backups/backup.sh
./infra/backups/verify.sh infra/backups/dashboard-<timestamp>.dump
```

`backup.sh` prints the new file name; use that timestamp. `verify.sh` needs Docker: it
starts a disposable PostgreSQL container with the image read from `compose.yaml`, with
no published port and no volume, and removes it at the end even on failure.

A backup is usable only when its `.verification.json` says `"verified"`. A `"failed"`
result names the reason:

| Reason | Meaning | Action |
| --- | --- | --- |
| `checksum mismatch` | The file changed after it was written (copy, disk, transfer). | Take a new backup; do not use this file. |
| `pg_restore failed` | The archive cannot be loaded even though its checksum is valid. | Take a new backup; compare the `pgDump` and `serverVersion` in the `.json`. |
| `no _prisma_migrations table` | The dump is not a dashboard database. | Check which database was dumped. |
| `the backup contains a failed migration` | The source database had an unresolved failed migration. | Fix the migration first (see [Migration deployment](./migrations.md)). |

## Rehearse a restore on a throwaway container

**Mutating, on throwaway data only.** This proves a real dump loads without touching the
compose database.

```sh
CONTAINER="presk-o-restore-rehearsal-$$"
docker run -d --rm --name "$CONTAINER" --tmpfs /var/lib/postgresql -p 127.0.0.1::5432 \
  -e POSTGRES_USER=dashboard -e POSTGRES_PASSWORD=dashboard -e POSTGRES_DB=dashboard \
  postgres:18.6-alpine3.24
until docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U dashboard -d dashboard >/dev/null 2>&1; do sleep 1; done

DB_CONTAINER="$CONTAINER" ./infra/backups/restore.sh \
  infra/backups/dashboard-<timestamp>.dump dashboard_restore_check

docker exec "$CONTAINER" psql -U dashboard -d dashboard_restore_check -tA \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
docker exec "$CONTAINER" psql -U dashboard -d dashboard_restore_check -tA \
  -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;"

docker rm -f "$CONTAINER"
```

Compare the two counts with `tables` and `migrations` in the dump's
`.verification.json`. The automated `test-backup-cycle.sh` does the same comparison and
also checks that corrupt archives are rejected.

## Recover a deployment

**Mutating.** This replaces the current database content with the dump. Read the whole
sequence before starting.

1. **Identify the dump**: the newest one whose `.verification.json` says `"verified"`.
   If none is verified, run `verify.sh` on the candidate first, and prefer a second
   candidate if it fails.
2. **Stop the application** so no session keeps the database open:
   ```sh
   docker compose --profile full stop app
   ```
   Without this, `DROP DATABASE` fails with `database "…" is being accessed by other
   users`.
3. **Preserve the current state when possible**, even if it is damaged:
   ```sh
   ./infra/backups/backup.sh /tmp/incident
   ```
   If the dump fails, record why; a failing dump is itself diagnostic evidence. This
   directory is outside the repository and contains personal data: delete it once the
   incident is closed.
4. **Restore** into the database named by `POSTGRES_DB` (export it first when it is not
   `dashboard`, because the script does not read `.env`):
   ```sh
   ./infra/backups/restore.sh \
     infra/backups/dashboard-<timestamp>.dump "${POSTGRES_DB:-dashboard}"
   ```
5. **Start the application** so the one-shot services run in order:
   ```sh
   docker compose --profile full up -d
   ```
   `migrate` applies any migration newer than the dump; `seed` refreshes the owner name
   and keeps the stored password unless `SEED_OWNER_FORCE_PASSWORD=true` (keep it
   `false` during a recovery).
6. **Verify the restored system**:
   - sign in with the owner account;
   - open **Diagnostic** (`/diagnostics`) and confirm database and migrations are OK;
   - spot-check a data page: the budget month totals, the last transactions, one
     property;
   - compare the newest operation date with the dump's creation date: anything created
     after that dump is legitimately absent.
7. **Take a new backup and verify it**. The restored database is now the baseline:
   ```sh
   ./infra/backups/backup.sh
   ./infra/backups/verify.sh infra/backups/dashboard-<new-timestamp>.dump
   ```

### If the restore fails

| Symptom | Cause and action |
| --- | --- |
| `database "…" is being accessed by other users` | The app or another client is connected. Stop `app` and retry. |
| `Dump file not found` | Wrong path; scripts run from the repository root. |
| `role "…" does not exist` | `POSTGRES_USER` does not match the database role. Export the right value. |
| `pg_restore: error: unsupported version` | The dump was produced by a newer PostgreSQL major. Use a matching image / `POSTGRES_IMAGE`, see the upgrade notes in [infra/backups/README.md](../../infra/backups/README.md). |
| Restore succeeds but pages error | The dump predates a migration; step 5 must run `migrate`. Check `/diagnostics`. |

## What is still manual

- **Scheduling.** Nothing runs `backup.sh` or `verify.sh` automatically. Wire them to
  cron, a systemd timer or the platform scheduler, and alert on a non-zero exit.
- **Off-host storage.** Dumps currently stay on the same disk as the database. Copy them
  encrypted to another host or object storage, and define a retention policy (for
  example 7 daily, 4 weekly, 12 monthly).
- **Restore tests.** Run a rehearsal on a schedule, not only once. An untested backup is
  a hope.
