# Token and secret rotation

Replace a provider token, rotate the key that encrypts it, or change the session secret
and the owner password. Every procedure keeps secrets server-side: never paste a token
into a shell command, a ticket or this repository, and never expect to read one back
from the application.

## What is stored where

| Secret | Where it lives | What a rotation invalidates |
| --- | --- | --- |
| GitHub / GitLab token | Encrypted with AES-256-GCM in `IntegrationConnection.credentialsCiphertext` | Nothing, if replaced correctly: the next synchronisation uses it. |
| AI provider key (OpenAI, Anthropic, OpenRouter) | Encrypted with AES-256-GCM in `AiProviderConnection.credentialsCiphertext` | Nothing, if replaced from the page: the new key is tested before it overwrites the old one. |
| `INTEGRATION_ENCRYPTION_KEY` | `.env` or the deployment secret store | Every stored provider token and AI provider key becomes unreadable. |
| `AUTH_SECRET` | `.env` or the deployment secret store | Every session (all devices are signed out). |
| Owner password | bcrypt hash in the `User` row | Every session, including the current one. |

The integrations page shows a connection's provider, instance, scopes, status and last
synchronisation. It never returns the token, not even masked.

## Replacing a provider token

**Read-only on the database.** This is the normal rotation when a token expires, is
revoked, or approaches its expiry date.

1. **Create the replacement token at the provider**, read-only, with the scopes the
   integrations page lists: `repo:read, public_repo:read, actions:read` for GitHub
   (`actions:read` is only needed for CI status) and `read_api` for GitLab. Grant
   nothing more: the adapters never write.
2. **Open `/integrations`** and expand **Ajouter ou remplacer une connexion**.
3. **Keep the identity fields identical**: the same **Fournisseur** and the same
   **URL d'instance**. The connection is identified by (workspace, provider, instance
   URL); an empty instance URL means the public instance. A different instance URL
   creates a second connection instead of replacing the token. Keep **Organisation ou
   groupe** as it was to track the same projects.
4. **Paste the new token** in **Jeton (lecture seule)** and save. A successful replace
   clears the previous synchronisation error and deletes the cached provider
   validators, so the next run reads everything again with the new credentials. The
   form does not call the provider: a wrong token is only detected by the next
   synchronisation.
5. **Run a synchronisation** from the **Connexions** table.
6. **Verify** that the latest run is `SUCCESS` (or `PARTIAL`, with the unread
   repositories named) and that **Diagnostic** reports the connection as synchronised.
7. **Revoke the old token at the provider** once the new one has synchronised
   successfully.

### If the token leaked

1. **Revoke it at the provider first.** Nothing in this application writes to a
   provider, so the exposure is read-only, but revocation is still the first action.
2. Replace it with the steps above.
3. If the exposed token had more than read access, reduce the new token to the scopes
   listed on the page, and review recent access at the provider side.

### If the instance URL really changed

A moved self-hosted GitLab, for example, cannot be "renamed" in place. Connecting the
new URL creates a second connection, and the old one remains in the list because the
interface has no delete action yet. Confirm this is acceptable before connecting; the
old token should be revoked at the old instance, and its snapshots stop updating.

## Replacing or revoking an AI provider key

**Coûts IA → Clés des fournisseurs** (`/ai-costs/connections`), owner or admin only.
The page shows each key's provider, account, permissions and last test; never the key,
not even masked.

The keys are organisation-level and can do more than read: an OpenAI admin key, an
Anthropic Admin API key, an OpenRouter management key. The application only reads with
them, but treat each as an administrator credential.

1. **Create the replacement key at the provider.** For OpenAI, restrict the admin key
   to read access on usage and projects; Anthropic and OpenRouter offer no narrower key.
2. **Paste it** in **Ajouter ou remplacer une clé** with the same **Fournisseur** and
   choose **Tester et enregistrer**. The key is tested with the provider first: a
   refused key is not stored, and the previous one stays in place, unchanged.
3. **Check** that the connection reads **Valide** with a fresh **Dernier test**.
4. **Revoke the old key in the provider console.** The application never deletes a key
   at the provider.

**Tester la clé** re-tests a stored key. A refusal (invalid, revoked or missing
permission) marks it **Refusée**, and no import uses it until a test passes or it is
replaced; a rate limit or an outage leaves the state as it was.

**Révoquer** (with the confirmation box) erases the stored ciphertext immediately and
keeps the row, so imported lines keep their connection. It cannot be undone: connect a
key again to resume imports. If the key leaked, revoke it **at the provider first**, then
here.

Each connection, replacement, test and revocation is in the **Journal d'audit**, with the
provider and an error code, never the key.

## Rotating `INTEGRATION_ENCRYPTION_KEY`

**Mutating for provider tokens.** The key decrypts every stored token. Replacing it
makes the existing ciphertext unreadable, and synchronisation answers `SKIPPED` with
reason `NO_TOKEN` until each token is entered again.

Plan a single sitting: the application cannot mix two keys, and re-entering one token
under the new key while keeping the old key for the others is not supported.

1. Generate the new key:
   ```sh
   openssl rand -base64 32
   ```
2. Put it in `.env` (or the deployment secret store) as `INTEGRATION_ENCRYPTION_KEY`.
3. Recreate the application so it reads the new environment:
   ```sh
   docker compose --profile full up -d
   ```
   Compose recreates a service whose environment changed. A plain `restart` reuses the
   old environment.
4. Open **Diagnostic** and confirm **Clé de chiffrement des jetons** is defined and valid
   (32 bytes); an invalid key is reported as an error, never printed.
5. For **each** connection, replace the token as described above (same provider and
   instance URL, new or same token value) and run a synchronisation. AI provider keys
   read **Refusée** with « clé enregistrée illisible » after **Tester la clé**: replace
   each one from `/ai-costs/connections`.
6. Destroy the old key once every connection has synchronised.

**Rollback:** going back to the old key works only while no token has been re-entered
under the new key. After the first replacement, the two keys own different ciphertexts
and a rollback breaks the ones already replaced. If you need a way back, take a database
backup before step 2 and restore it instead.

## Rotating `AUTH_SECRET`

**Mutating for sessions.** Sessions are signed with this secret; replacing it signs
every device out.

1. Generate a value of at least 32 characters:
   ```sh
   openssl rand -base64 32
   ```
2. Put it in `.env` or the deployment secret store as `AUTH_SECRET`.
3. Recreate the application (`docker compose --profile full up -d`, or restart
   `npm run dev` / `npm start`).
4. Open **Diagnostic** and confirm **Secret de session** is OK.
5. Sign in again on each device. No data is affected.

## Changing the owner password

### From the application

**Compte** (`/account`) changes the password. The server requires the current password,
a new password of at least 12 characters and at most 72 bytes, and signs every session
out after the change, including the current one. Use this path when the owner still has
access.

### Forgotten password

**Mutating.** There is no self-service recovery. The seed is the way back:

1. Set `SEED_OWNER_FORCE_PASSWORD=true` and the desired `SEED_OWNER_PASSWORD` in `.env`
   or the deployment environment.
2. Run the seed:
   ```sh
   docker compose --profile full run --rm seed
   ```
   or, on a workstation with the database reachable, `npm run db:seed`.
3. Sign in with the environment password.
4. **Set `SEED_OWNER_FORCE_PASSWORD=false` again.** While it is `true`, every `up` and
   every seed run resets the stored hash to the environment value, silently undoing a
   password changed from the **Compte** page. The **Compte** page warns when the flag is
   active.

## Revoking sessions

**Compte** lists the active sessions with a coarse client family and its dates, never a
token. It can revoke one session or every other session. A password change and an
`AUTH_SECRET` rotation revoke all of them at once.

## What never to do

- Do not edit `credentialsCiphertext`, `passwordHash` or session rows by hand. Ciphertext
  is bound to the key, and the session guard compares a password fingerprint.
- Do not put a token in a documented command, a shell history, a log line or a support
  ticket. The application never displays one; neither should a runbook.
- Do not connect a company GitLab without checking the internal policy first. Only the
  groups and repositories explicitly authorised should be tracked.
