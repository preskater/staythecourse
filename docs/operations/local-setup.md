# Local setup

Bring a workstation from a fresh clone to a signed-in dashboard, using the local
PostgreSQL container. Fictitious values only; the owner account is created by the seed,
there is no public sign-up.

## Prerequisites

- Node.js 22 or later (`node -v`). CI and the Docker image both use Node 22.
- Docker with Compose v2 (`docker info` must succeed).
- `openssl`, for generating the two server secrets.

## 1. Install dependencies

```sh
npm ci
npm run db:generate
```

`npm ci` installs exactly `package-lock.json`. `db:generate` writes the Prisma client to
`src/generated/prisma`, which is generated code, not committed: tests, type checking and
the build need it. Use `npm install` only when you are changing dependencies.

## 2. Configure the environment

```sh
cp .env.example .env
```

Edit `.env` and replace the two placeholders with values generated locally:

```sh
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # INTEGRATION_ENCRYPTION_KEY
```

- `AUTH_SECRET` must be at least 32 characters. Rotating it signs every session out.
- `INTEGRATION_ENCRYPTION_KEY` must decode from base64 to exactly 32 bytes. It encrypts
  provider tokens at rest; changing it makes existing tokens unreadable (see
  [Token and secret rotation](./token-rotation.md)).
- `.env` is git-ignored. `.env.example` keeps fictitious values only.
- The template's `AUTH_URL=http://localhost:3000` is direct local access. It must be a
  valid absolute URL: a value left as a placeholder such as `http://<your-ip>:3000`
  makes every page fail with `ERR_INVALID_URL`. When the local Caddy override is in use,
  set `AUTH_URL`, `APP_HOST` and `PROXY_PORT` to the same origin you type (for example
  `http://dashboard.localhost:8888` with `PROXY_PORT=8888`).

The default `DATABASE_URL` matches the compose database
(`postgresql://dashboard:dashboard@localhost:5432/dashboard?schema=public`). If you
change `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` or `POSTGRES_PORT`, update
`DATABASE_URL` in the same edit.

## 3. Start PostgreSQL and prepare the schema

```sh
docker compose up -d --wait db
npm run db:deploy
npm run db:seed
```

- `db:deploy` applies the committed migrations. It is the non-interactive command; use
  `npm run db:migrate` only when you are authoring a migration (see
  [Migration deployment](./migrations.md)).
- `db:seed` creates the owner from `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` and
  `SEED_OWNER_NAME`, or refreshes the name of the account that exists. The stored
  password is kept once the account exists, unless `SEED_OWNER_FORCE_PASSWORD=true`.
- The same run creates the owner's personal workspace (`SEED_WORKSPACE_NAME`, default
  `Personnel`), the membership that makes it reachable and the modules it starts with
  (`SEED_WORKSPACE_MODULES`, default `budget,real-estate,development`). Running it
  again duplicates nothing and never re-enables a module disabled from the **Modules**
  page; `npm run db:seed:check` verifies the result on a throwaway database.
- Server configuration is validated lazily by `src/lib/env.ts`: a missing or malformed
  secret fails on first use with the variable names, not with an obscure error later.

## 4. Run the application

```sh
npm run dev
```

Open `http://localhost:3000` and sign in with the `SEED_OWNER_*` address and password.

If a local `compose.override.yaml` is present, the full stack puts the Caddy proxy in
front of the application and the address to browse is `APP_HOST`, published on
`PROXY_PORT` (with `.env.example`: `http://localhost:3000`; the override's fallback when
those variables are unset is `http://dashboard.localhost:8888`). In that case the app
port is not published; see the proxy section of the
[README](../../README.md#the-proxy-and-the-address-you-browse). A fresh clone has no
override file, so `npm run dev` is reached directly.

## 5. Verify the installation

```sh
curl -s -o /dev/null -w '/login %{http_code}\n' http://localhost:3000/login
curl -s -o /dev/null -w '/dashboard %{http_code} -> %{redirect_url}\n' http://localhost:3000/dashboard
```

Expected: `/login` answers `200`, and `/dashboard` answers `307` with a redirect to
`/login` because no session is open. Signing in should then show the dashboard; the
**Compte** page must offer **Diagnostic du système**.

Optional, still with fictitious data: `npm run lint`, `npm run typecheck` and
`npm run test`. No test connects to a database or performs a real network call.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint`, `npm run typecheck`, `npm run test` | Quality checks |
| `npm run db:generate` | Regenerate the Prisma client after a schema change |
| `npm run db:migrate` | Author and apply a migration (development) |
| `npm run db:deploy` | Apply committed migrations |
| `npm run db:seed` | Create or refresh the owner account |
| `npm run db:studio` | Browse the database locally |
| `npm run db:cleanup` | Prune synchronisation history (90-day retention) |

## Ports already in use

| Port | Variable | Remedy |
| --- | --- | --- |
| 3000 | `PORT` (dev server) or `APP_PORT` (compose) | `PORT=3100 npm run dev`, or set `APP_PORT` |
| 8888 | `PROXY_PORT` | Set another port and update `APP_HOST` to the same origin |
| 5432 | `POSTGRES_PORT` | Set another port **and** update `DATABASE_URL` |

`AUTH_URL`, `APP_HOST` and `PROXY_PORT` describe a single origin and must agree. A
mismatch does not look like an error in `docker compose ps`: it shows up as an empty
page or as a session that exists on a different host.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `500` on every page with `ERR_INVALID_URL` in the server log | `AUTH_URL` is not a valid absolute URL, typically a leftover placeholder. Set `AUTH_URL=http://localhost:3000` (or the origin you browse). |
| `Invalid or missing server environment variables: AUTH_SECRET, …` | `.env` is missing or incomplete. Copy `.env.example` and fill the secrets. |
| `Can't reach database server` | `docker compose up -d --wait db`; check `POSTGRES_PORT` and `DATABASE_URL` agree. |
| Type errors about `@/generated/prisma` after a pull | Run `npm run db:generate`. |
| Sign-in refused with the password from `.env` | The seed keeps an existing hash. Set `SEED_OWNER_FORCE_PASSWORD=true`, run `npm run db:seed`, then set it back to `false`. |
| A migration fails locally | Stop and follow [Migration deployment](./migrations.md). Do not reset a database you care about. |

## Stopping and resetting

```sh
docker compose down        # stops containers, keeps the database volume
docker compose down -v     # DESTROYS the database volume and its data
```

**Mutating:** `down -v` deletes the local database. It is only acceptable for a
workstation database you can rebuild from migrations and the seed; it is never a
recovery step for data you want to keep. The volume name is pinned in `compose.yaml`
(`staythecourse_db-data`) or in the local override (`dashboard_db-data`), so it does not
depend on the directory name. Take a verified backup first if anything in it matters.
