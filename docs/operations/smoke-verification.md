# Smoke verification

Prove that a build actually works — database, migrations, seed, sign-in, diagnostics and
backup/restore — without touching real data. Run it after a deployment, before a
release, and after changing an environment variable, a compose service or a backup
script.

## Level 1 — repository checks

No database and no network beyond the package registry:

```sh
npm ci
npm run db:generate
npm run lint
npm run typecheck
npm run test
npm run build
```

Then the backup/restore cycle, which uses its own throwaway container and fictitious
data (Docker required, about 20 seconds):

```sh
./infra/backups/test-backup-cycle.sh
```

It applies the real migrations, seeds a fictitious owner, backs up, verifies, rehearses
`restore.sh`, and checks that a truncated archive is rejected by its checksum and a
corrupt archive with a recomputed checksum is rejected by the restore itself. CI runs
the same script.

## Level 2 — end-to-end throwaway stack

An ephemeral PostgreSQL container, the real application, the real scripts. No compose
service is used, no real volume is mounted, and every value below is fictitious.

Run the whole block in **one fresh `bash` shell** from the repository root. Two things
make it safe:

- `DATABASE_URL` is built from the random port just published by the throwaway
  container, and the guard refuses to continue if it does not match;
- the container uses `--tmpfs`, so its data disappears when it is removed.

> The repository's `.env` points at the real local database. Exported variables win over
> `.env` (Next.js and dotenv do not override the environment), which is why every
> variable the stack reads is exported here. Do not skip the guard, and do not reuse a
> `DB_PORT` you did not just allocate.

```sh
# --- Throwaway database -----------------------------------------------------
CONTAINER="presk-o-smoke-db-$$"
WORK="$(mktemp -d)"
COOKIES="$WORK/cookies.txt"
mkdir -p "$WORK/backups"

docker run -d --rm --name "$CONTAINER" --tmpfs /var/lib/postgresql -p 127.0.0.1::5432 \
  -e POSTGRES_USER=dashboard -e POSTGRES_PASSWORD=dashboard -e POSTGRES_DB=dashboard \
  postgres:18.6-alpine3.24
until docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U dashboard -d dashboard >/dev/null 2>&1; do
  sleep 1
done
DB_PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"

# --- Fictitious configuration ----------------------------------------------
export DATABASE_URL="postgresql://dashboard:dashboard@127.0.0.1:${DB_PORT}/dashboard?schema=public"
export AUTH_SECRET="smoke-only-fictitious-secret-0123456789"
export INTEGRATION_ENCRYPTION_KEY="c21va2Utb25seS1maWN0aXRpb3VzLWtleS0zMi1ieXQ="
export AUTH_TRUST_HOST=true
export AUTH_URL="http://127.0.0.1:3100"
export NEXT_PUBLIC_DEFAULT_CURRENCY=EUR
export NEXT_PUBLIC_DEFAULT_TIME_ZONE=Europe/Paris
export SEED_OWNER_EMAIL="owner@example.test"
export SEED_OWNER_PASSWORD="Fictitious-Password-2026"
export SEED_OWNER_NAME="Proprietaire fictif"
export SEED_OWNER_FORCE_PASSWORD=false
export BACKUP_DIR="$WORK/backups"
export POSTGRES_USER=dashboard
export POSTGRES_DB=dashboard

case "$DATABASE_URL" in
  *":${DB_PORT}/dashboard"*) echo "OK: throwaway database on port ${DB_PORT}" ;;
  *) echo "REFUSING: DATABASE_URL does not point at the throwaway container"; exit 1 ;;
esac
```

Prepare the data and build. The seed runs twice on purpose: the second run must add
nothing, which `db:seed:check` then verifies — one owner resolving to its personal
workspace with the selected modules, no duplicated row:

```sh
npm run db:deploy
npm run db:seed
npm run db:seed
npm run db:seed:check
npm run build
```

Start the production server and run the checks:

```sh
PORT=3100 npm start >"$WORK/app.log" 2>&1 &
SERVER_JOB=$!
for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:3100/login && break; sleep 1; done

curl -s -o /dev/null -w '/login %{http_code}\n' http://127.0.0.1:3100/login
curl -s -o /dev/null -w '/diagnostics %{http_code} -> %{redirect_url}\n' \
  http://127.0.0.1:3100/diagnostics
curl -s -o /dev/null -w '/manifest.webmanifest %{http_code}\n' \
  http://127.0.0.1:3100/manifest.webmanifest
```

Expected: `/login` `200`, `/diagnostics` `307` to `/login` (no session), manifest `200`.
Then sign in with the fictitious owner and open the authenticated diagnostics page:

```sh
CSRF="$(curl -s -c "$COOKIES" http://127.0.0.1:3100/api/auth/csrf \
  | sed 's/.*"csrfToken":"\([^"]*\)".*/\1/')"
curl -s -b "$COOKIES" -c "$COOKIES" -o /dev/null -w 'sign-in %{http_code}\n' \
  -X POST http://127.0.0.1:3100/api/auth/callback/credentials \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$SEED_OWNER_EMAIL" \
  --data-urlencode "password=$SEED_OWNER_PASSWORD" \
  --data-urlencode "callbackUrl=http://127.0.0.1:3100/dashboard"
curl -s -b "$COOKIES" -o /dev/null -w '/dashboard %{http_code}\n' \
  http://127.0.0.1:3100/dashboard
curl -s -b "$COOKIES" http://127.0.0.1:3100/diagnostics | grep -q "La base répond" \
  && echo "OK: diagnostics reads the database"
```

Expected: sign-in `302`, dashboard `200`, diagnostics contains `La base répond`.

Back up, verify, and rehearse the restore on the same throwaway container:

```sh
./infra/backups/backup.sh "$WORK/backups"
DUMP="$(ls "$WORK"/backups/dashboard-*.dump)"
./infra/backups/verify.sh "$DUMP"

DB_CONTAINER="$CONTAINER" ./infra/backups/restore.sh "$DUMP" dashboard_restore_check
docker exec "$CONTAINER" psql -U dashboard -d dashboard_restore_check -tA \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
```

Compare the printed table count with `tables` in `dashboard-<timestamp>.verification.json`
(`verify.sh` also prints it). Then clean up:

```sh
kill "$SERVER_JOB"
# `next start` runs under npm and may leave its server child holding the port.
PIDS="$(lsof -ti tcp:3100)"
[ -n "$PIDS" ] && kill $PIDS
docker rm -f "$CONTAINER"
rm -rf "$WORK"
```

The cookie jar contains a session cookie for a throwaway account; removing `$WORK`
removes it. Confirm `lsof -ti tcp:3100` prints nothing before reusing port 3100.

### What this proves, and what it does not

| Proves | Does not prove |
| --- | --- |
| Committed migrations apply to an empty database | A migration that only fails on existing production data |
| The seed creates the owner and sign-in works | A real provider token, a real sync, or provider quota behaviour |
| Every route renders server-side with the session guard | The reverse proxy, TLS, DNS or the browsable origin |
| Backup, verification and restore work with the real scripts | Off-host backup copies, scheduling or retention |
| Diagnostics can read the database and the backup folder | Disk space, host health or external monitoring |

Provider synchronisation is deliberately excluded: it needs a real token, and tokens
never belong in a smoke test. Cover it once on the deployment by connecting a read-only
token and reading `/diagnostics` (see
[Failed synchronisation recovery](./failed-synchronisation.md)).

## Level 3 — smoke a deployed stack

Non-destructive, on the real origin:

```sh
ORIGIN='https://dashboard.example.test'
```

1. `docker compose --profile full ps` shows `db` and `app` healthy (and `proxy` if the
   local override is present).
2. `curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/login"` answers `200`; `/dashboard`
   redirects to `/login` without a session.
3. Sign in and open **Diagnostic**. Database, migrations, keys and version must be OK;
   connections and backups may legitimately warn (not connected / older than 7 days).
4. Open one data page (budget month, real estate) and confirm figures, not placeholders.
5. Confirm the newest verified backup is recent, or take one now:
   [Backup and restore](./backup-restore.md).

Record the date, the origin and the result of each step in the release notes or the pull
request. A smoke test that was not written down is a rumour.
