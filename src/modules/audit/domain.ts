/**
 * Audit trail vocabulary (SO-02 / M18-02).
 *
 * The trail answers "who did what, and did it work" for actions that are expensive to
 * reconstruct after the fact: sign-in, credential and password changes, ledger writes,
 * module and rate changes, provider connections, exports and operator procedures.
 * It is deliberately poor in data — a code, an identifier, a count, a calendar day —
 * because an audit log that copies the ledger becomes a second copy of personal data
 * with a different lifetime.
 *
 * Action codes are stable text stored as-is, like module keys: adding one needs no
 * migration. Renaming one would break the history, so add a new code instead.
 */

export const AUDIT_ACTIONS = [
  // Deliveries of personal data.
  "export.transactions",
  "export.properties",
  "export.budgets",
  "export.goals",
  "export.alerts",
  // Authentication and credentials. A refusal is a denial code, never the submitted
  // address or password.
  "auth.sign_in",
  "auth.sign_in_refused",
  "auth.sign_out",
  "auth.password_change",
  "auth.password_change_refused",
  "auth.session_revoke",
  // Ledger changes. Transaction references only: no label, amount or note.
  "transaction.create",
  "transaction.update",
  "transaction.delete",
  "transaction.transfer",
  "transaction.reconcile",
  "transaction.salary_book",
  // Configuration that changes what the dashboard computes.
  "rate.write",
  // Estimate versions (M10-04): creation and approval are the only transitions.
  "estimate.version_create",
  "estimate.approve",
  "module.enable",
  "module.disable",
  // Provider connections and deferred reads.
  "integration.connect",
  "integration.sync",
  // Operator procedures, recorded by a server-side job rather than the browser.
  "backup.run",
  "restore.run",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * How long the trail is kept (M18-02, tied to DR-05).
 *
 * One year covers an annual review and an incident that surfaces late, while keeping
 * rows that carry no payload. The operator job applies it; no page or action deletes
 * an entry.
 */
export const AUDIT_RETENTION_DAYS = 365;

/** Coarse family of the row an entry is about. */
export const AUDIT_ENTITY_TYPES = [
  "EXPORT",
  "SESSION",
  "USER",
  "TRANSACTION",
  "TRANSFER",
  "SALARY_RATE",
  "ESTIMATE",
  "MODULE",
  "INTEGRATION",
  "OPERATION",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * How the attempt ended.
 *
 * A refused export reads nothing, and recording every malformed link would let a
 * client fill the trail. `REFUSED` and `FAILED` are there for writers that do change
 * data and must say that they did not.
 */
export const AUDIT_OUTCOMES = ["SUCCESS", "REFUSED", "FAILED"] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === "string" && (AUDIT_OUTCOMES as readonly string[]).includes(value);
}

/** What is written when a value could not be stored as-is (see `redactAuditMetadata`). */
export const REDACTED_METADATA_VALUE = "[redacted]";

export type AuditMetadata = Record<string, string | number | boolean>;

/**
 * Keys that would turn the trail into a copy of the data it describes.
 *
 * They are dropped, not masked: keeping the key with a placeholder still tells a reader
 * that `amount` or `email` was involved, and that is already more than the trail needs.
 */
const SENSITIVE_KEY =
  /(token|secret|password|hash|credential|cookie|session|email|label|note|address|amount|balance|reason|payload|content|query|search|ciphertext|api_?key|private_?key|access_?key|url|uri|host|login)/i;

/** A key we accept: short, ASCII, no punctuation. */
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/**
 * Shapes of credentials that must never be stored, even under an innocent key such as
 * `id`. A key-name rule catches `token`; this catches the value itself.
 */
const SECRET_VALUE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** True for a value whose shape is a credential, whatever the surrounding key says. */
export function looksLikeCredential(value: string): boolean {
  return SECRET_VALUE.test(value);
}

/**
 * A value we accept as-is: a code, a month or calendar day, an identifier. Anything
 * with a space, a comma or a quote is free text read from the ledger — it is redacted
 * rather than truncated, because half a label is still a label.
 */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;

/**
 * Keeps only what the trail is allowed to store.
 *
 * - a key matching `SENSITIVE_KEY`, or not looking like a code, is dropped altogether;
 * - a boolean or a finite number is kept (counts, `truncated`); an amount is caught by
 *   its key, never by its type;
 * - a string is kept only when it looks like a code; a credential-shaped value is
 *   dropped, and any other free text becomes `[redacted]`;
 * - anything else (`null`, a nested object, an array) is dropped: the column is a flat
 *   map of codes, not a payload.
 */
export function redactAuditMetadata(
  metadata: Record<string, unknown> | undefined = {},
): AuditMetadata {
  const safe: AuditMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_KEY.test(key) || SENSITIVE_KEY.test(key)) {
      continue;
    }

    if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) {
        safe[key] = value;
      }
    } else if (typeof value === "string") {
      // A credential is dropped, not masked: the key alone would still say one was used.
      if (SECRET_VALUE.test(value)) {
        continue;
      }
      safe[key] = SAFE_VALUE.test(value) ? value : REDACTED_METADATA_VALUE;
    }
  }

  return safe;
}
