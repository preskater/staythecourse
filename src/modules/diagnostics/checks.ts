import { decodeEncryptionKey } from "@/lib/crypto";
import { serverEnvSchema } from "@/lib/env";
import type { ConnectionSummary } from "@/modules/integrations/domain";
import { plural } from "@/lib/word";

/**
 * System diagnostics (SO-03): pure checks, one per operational question.
 *
 * Each check turns what a probe observed into a status and a safe French message, plus
 * the action to take when something is wrong. No check ever returns a secret, a part
 * of one, a connection string or a raw error message: only fixed sentences, counts,
 * names of migrations and dates. The probes that read the system live in `run.ts`.
 */

export type CheckStatus = "ok" | "warning" | "error";

export type DiagnosticCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  /** What to do about a warning or an error; null when nothing is needed. */
  action: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A backup older than this is reported as a warning. */
export const BACKUP_MAX_AGE_DAYS = 7;
/** A connection not synchronised for this long is reported as a warning. */
export const SYNC_MAX_AGE_DAYS = 7;

function check(
  id: string,
  label: string,
  status: CheckStatus,
  message: string,
  action: string | null = null,
): DiagnosticCheck {
  return { id, label, status, message, action };
}

/** `reachable` comes from a `SELECT 1` bounded by a timeout. */
export function checkDatabase(reachable: boolean): DiagnosticCheck {
  return reachable
    ? check("database", "Base de données", "ok", "La base répond.")
    : check(
        "database",
        "Base de données",
        "error",
        "La base ne répond pas.",
        "Vérifiez que PostgreSQL tourne (en local : docker compose up -d --wait db) et que DATABASE_URL pointe vers lui.",
      );
}

export type AppliedMigration = { name: string; finished: boolean; rolledBack: boolean };

/**
 * `applied` is null when the database could not be read; `expected` is null when the
 * migration folder is not visible from the running application.
 */
export function checkMigrations(
  applied: readonly AppliedMigration[] | null,
  expected: readonly string[] | null,
): DiagnosticCheck {
  const id = "migrations";
  const label = "Migrations";

  if (applied === null) {
    return check(id, label, "error", "État des migrations illisible : la base ne répond pas.", "Rétablissez d'abord l'accès à la base.");
  }

  const failed = applied.filter((migration) => !migration.finished && !migration.rolledBack);
  if (failed.length > 0) {
    return check(
      id,
      label,
      "error",
      `${plural(failed.length, "migration")} en échec : ${failed.map((migration) => migration.name).join(", ")}.`,
      "Consultez les journaux du service migrate, corrigez la cause, puis relancez npm run db:deploy (ou le service migrate).",
    );
  }

  const done = new Set(applied.filter((migration) => migration.finished).map((migration) => migration.name));

  if (expected === null) {
    return check(
      id,
      label,
      "warning",
      `${plural(done.size, "migration")} appliquée${done.size > 1 ? "s" : ""}, aucune en échec. Les migrations en attente ne sont pas détectables : le dossier prisma/migrations n'est pas visible depuis l'application.`,
      "Copiez prisma/migrations dans l'image (voir le Dockerfile) pour activer cette vérification.",
    );
  }

  const pending = expected.filter((name) => !done.has(name));
  if (pending.length > 0) {
    return check(
      id,
      label,
      "error",
      `${plural(pending.length, "migration")} en attente : ${pending.join(", ")}.`,
      "Appliquez-les : npm run db:deploy en local, ou relancez le service migrate.",
    );
  }

  return check(id, label, "ok", `À jour : ${plural(expected.length, "migration")} appliquée${expected.length > 1 ? "s" : ""}.`);
}

/** Presence and validity only: the value itself never leaves this function. */
export function checkEncryptionKey(value: string | undefined): DiagnosticCheck {
  const id = "encryption-key";
  const label = "Clé de chiffrement des jetons";

  if (!value) {
    return check(id, label, "error", "INTEGRATION_ENCRYPTION_KEY n'est pas définie.", "Générez une clé avec openssl rand -base64 32 et ajoutez-la à l'environnement.");
  }

  try {
    decodeEncryptionKey(value);
  } catch {
    // The decoder's message is not forwarded: it describes the value.
    return check(id, label, "error", "INTEGRATION_ENCRYPTION_KEY est définie mais invalide : 32 octets encodés en base64 sont attendus.", "Remplacez-la par une clé générée avec openssl rand -base64 32. Les jetons déjà chiffrés devront être ressaisis.");
  }

  return check(id, label, "ok", "Définie et valide (32 octets).");
}

/** Same rule as `getServerEnv()`; the value itself is never returned. */
export function checkAuthSecret(value: string | undefined): DiagnosticCheck {
  const id = "auth-secret";
  const label = "Secret de session";

  if (!value) {
    return check(id, label, "error", "AUTH_SECRET n'est pas défini.", "Générez-le avec openssl rand -base64 32 et ajoutez-le à l'environnement.");
  }
  if (!serverEnvSchema.shape.AUTH_SECRET.safeParse(value).success) {
    return check(id, label, "error", "AUTH_SECRET est trop court : 32 caractères minimum.", "Remplacez-le par une valeur générée avec openssl rand -base64 32. Toutes les sessions seront fermées.");
  }
  return check(id, label, "ok", "Défini, longueur suffisante.");
}

/** `connections` is null when they could not be read. */
export function checkConnections(
  connections:
    | readonly Pick<ConnectionSummary, "provider" | "instanceUrl" | "status" | "lastSyncedAt" | "lastSyncError">[]
    | null,
  now: Date,
): DiagnosticCheck {
  const id = "connections";
  const label = "Connexions GitHub / GitLab";

  if (connections === null) {
    return check(id, label, "error", "État des connexions illisible : la base ne répond pas.", "Rétablissez d'abord l'accès à la base.");
  }

  if (connections.length === 0) {
    return check(id, label, "ok", "Aucune connexion configurée.");
  }

  const problems: string[] = [];
  let worst: CheckStatus = "ok";

  for (const connection of connections) {
    const name = `${connection.provider === "GITHUB" ? "GitHub" : "GitLab"} (${hostOf(connection.instanceUrl)})`;

    if (connection.status === "NOT_CONNECTED") {
      if (worst === "ok") worst = "warning";
      problems.push(`${name} : non connectée`);
    } else if (connection.status === "ERROR") {
      worst = "error";
      // `lastSyncError` is the stored safe code (see ProviderError.toSafeMessage).
      problems.push(`${name} : dernière synchronisation en erreur (${connection.lastSyncError ?? "code inconnu"})`);
    } else if (!connection.lastSyncedAt) {
      if (worst === "ok") worst = "warning";
      problems.push(`${name} : jamais synchronisée`);
    } else if (now.getTime() - connection.lastSyncedAt.getTime() > SYNC_MAX_AGE_DAYS * DAY_MS) {
      if (worst === "ok") worst = "warning";
      const days = Math.floor((now.getTime() - connection.lastSyncedAt.getTime()) / DAY_MS);
      problems.push(`${name} : dernière synchronisation il y a ${days} jours`);
    }
  }

  if (problems.length === 0) {
    return check(id, label, "ok", `${plural(connections.length, "connexion")}, toutes synchronisées depuis moins de ${SYNC_MAX_AGE_DAYS} jours.`);
  }

  return check(
    id,
    label,
    worst,
    `${problems.join(" ; ")}.`,
    "Ouvrez la page Intégrations : relancez la synchronisation, ou reconnectez le fournisseur si le jeton a expiré ou été révoqué.",
  );
}

/** Host only: a stored URL never carries credentials, but the path is not needed either. */
function hostOf(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return "instance";
  }
}

const BACKUP_NAME = /^dashboard-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

/** Instant encoded in a `backup.sh` file name, or null for any other file. */
export function backupInstant(fileName: string): Date | null {
  const match = BACKUP_NAME.exec(fileName);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls an impossible day over (month 13 → next year): refuse it instead.
  const roundTrips =
    instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day && instant.getUTCHours() === hour;
  return roundTrips ? instant : null;
}

/**
 * `fileNames` is the listing of the backup directory, or null when the directory is
 * not visible from the application. Only names are read, never the dumps.
 */
export function checkBackups(fileNames: readonly string[] | null, now: Date): DiagnosticCheck {
  const id = "backups";
  const label = "Dernière sauvegarde";

  if (fileNames === null) {
    return check(
      id,
      label,
      "warning",
      "Le dossier des sauvegardes n'est pas visible depuis l'application : leur âge est inconnu.",
      "Montez infra/backups en lecture seule dans le conteneur de l'application et renseignez BACKUP_DIR (voir compose.yaml).",
    );
  }

  const latest = fileNames
    .map(backupInstant)
    .filter((instant): instant is Date => instant !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  if (!latest) {
    return check(id, label, "error", "Aucune sauvegarde trouvée.", "Lancez ./infra/backups/backup.sh, puis vérifiez-la avec restore.sh sur une base jetable.");
  }

  const days = Math.floor((now.getTime() - latest.getTime()) / DAY_MS);
  const when = days === 0 ? "aujourd'hui" : `il y a ${plural(days, "jour")}`;

  if (days > BACKUP_MAX_AGE_DAYS) {
    return check(id, label, "warning", `Dernière sauvegarde ${when}, au-delà de ${BACKUP_MAX_AGE_DAYS} jours.`, "Lancez ./infra/backups/backup.sh.");
  }
  // ponytail: age only — whether the dump restores is SO-04's verification.
  return check(id, label, "ok", `Dernière sauvegarde ${when}. Sa restauration n'est pas vérifiée ici.`);
}

/** `build` is an optional identifier given at deploy time (for example a commit hash). */
export function checkVersion(packageVersion: string, build: string | undefined): DiagnosticCheck {
  const safeBuild = build && /^[\w.-]{1,64}$/.test(build) ? build : null;
  return check(
    "version",
    "Version",
    "ok",
    safeBuild ? `${packageVersion} (build ${safeBuild})` : `${packageVersion} (APP_VERSION non renseignée)`,
  );
}
