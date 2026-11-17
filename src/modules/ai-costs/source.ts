/**
 * Traceability of a cost amount.
 *
 * A source reference answers "where did this figure come from?" without ever
 * holding the answer itself (no token, no payload, no credential). References
 * are frozen plain data: the instant a value was captured is part of the
 * reference and can never be edited afterwards.
 */

export const COST_SOURCE_KINDS = ["provider", "import", "manual"] as const;
export type CostSourceKind = (typeof COST_SOURCE_KINDS)[number];

type SourceTiming = {
  /** Instant the reference was captured. Defaults to now; always stored in UTC. */
  capturedAt?: Date | string;
};

export type ProviderCostSourceInput = {
  kind: "provider";
  /** Stable provider identifier, for example `openai` or `github`. */
  provider: string;
  /** Provider-side identifier of the invoice, usage record or subscription. */
  externalId: string;
} & SourceTiming;

export type ImportCostSourceInput = {
  kind: "import";
  importId: string;
  /** 1-based row number in the imported file. */
  rowNumber: number;
} & SourceTiming;

export type ManualCostSourceInput = {
  kind: "manual";
  /** Identifier of the workspace member who entered the amount. */
  enteredBy: string;
} & SourceTiming;

export type CostSourceInput =
  | ProviderCostSourceInput
  | ImportCostSourceInput
  | ManualCostSourceInput;

type BaseSourceReference = {
  /** ISO-8601 instant in UTC, distinct from any operation date. */
  readonly capturedAt: string;
};

export type ProviderCostSourceReference = BaseSourceReference & {
  readonly kind: "provider";
  readonly provider: string;
  readonly externalId: string;
};

export type ImportCostSourceReference = BaseSourceReference & {
  readonly kind: "import";
  readonly importId: string;
  readonly rowNumber: number;
};

export type ManualCostSourceReference = BaseSourceReference & {
  readonly kind: "manual";
  readonly enteredBy: string;
};

export type CostSourceReference =
  | ProviderCostSourceReference
  | ImportCostSourceReference
  | ManualCostSourceReference;

export type CreateCostSourceOptions = {
  /** Injectable clock, for deterministic tests. */
  now?: Date;
};

export class InvalidCostSourceError extends Error {
  constructor(readonly field: string, reason: string) {
    super(`Invalid cost source ${field}: ${reason}`);
    this.name = "InvalidCostSourceError";
  }
}

/**
 * A reference must never look like a credential.
 *
 * The error names the field only: echoing the rejected value would copy the
 * secret into logs and error captures.
 */
export class UnsafeSourceReferenceError extends Error {
  constructor(readonly field: string) {
    super(`Unsafe cost source ${field}: identifiers must not contain a secret or a token.`);
    this.name = "UnsafeSourceReferenceError";
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/,
  /\bglpat-[A-Za-z0-9_-]{8,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/,
  /\bAKIA[0-9A-Z]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}/i,
];

/**
 * True when a free-form identifier looks like a credential.
 *
 * Shared with the ledger dimensions: a token pasted into `issueId` must be refused
 * just like one pasted into a source reference.
 */
export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function toReferenceText(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidCostSourceError(field, "expected a string");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new InvalidCostSourceError(field, "expected between 1 and 256 characters");
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidCostSourceError(field, "control characters are not allowed");
  }

  if (looksLikeSecret(trimmed)) {
    throw new UnsafeSourceReferenceError(field);
  }

  return trimmed;
}

function toProviderId(value: unknown): string {
  const provider = toReferenceText("provider", value);

  if (!PROVIDER_PATTERN.test(provider)) {
    throw new InvalidCostSourceError(
      "provider",
      "expected a lowercase identifier made of letters, digits, dots, dashes or underscores",
    );
  }

  return provider;
}

function toCapturedAt(value: Date | string | undefined, now: Date): string {
  if (value === undefined) {
    if (Number.isNaN(now.getTime())) {
      throw new InvalidCostSourceError("now", "expected a valid date");
    }

    return now.toISOString();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidCostSourceError("capturedAt", "expected a valid instant");
    }

    return value.toISOString();
  }

  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    throw new InvalidCostSourceError(
      "capturedAt",
      "expected an ISO-8601 instant with an explicit time zone",
    );
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidCostSourceError("capturedAt", "expected a valid instant");
  }

  return parsed.toISOString();
}

function toRowNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidCostSourceError("rowNumber", "expected a positive integer");
  }

  return value;
}

/**
 * Builds an immutable source reference.
 *
 * `capturedAt` is normalised to UTC and stored as a string: a mutable `Date`
 * could otherwise be changed after the reference was created. The returned
 * object is frozen, so its kind, identifiers and timestamp cannot be rewritten.
 */
export function createCostSource(
  input: CostSourceInput,
  options: CreateCostSourceOptions = {},
): CostSourceReference {
  const kind = (input as { kind?: unknown } | null | undefined)?.kind;

  if (kind !== "provider" && kind !== "import" && kind !== "manual") {
    throw new InvalidCostSourceError("kind", "expected provider, import or manual");
  }

  const capturedAt = toCapturedAt(
    (input as { capturedAt?: Date | string }).capturedAt,
    options.now ?? new Date(),
  );

  if (kind === "provider") {
    return Object.freeze({
      kind: "provider" as const,
      provider: toProviderId((input as ProviderCostSourceInput).provider),
      externalId: toReferenceText(
        "externalId",
        (input as ProviderCostSourceInput).externalId,
      ),
      capturedAt,
    });
  }

  if (kind === "import") {
    return Object.freeze({
      kind: "import" as const,
      importId: toReferenceText(
        "importId",
        (input as ImportCostSourceInput).importId,
      ),
      rowNumber: toRowNumber((input as ImportCostSourceInput).rowNumber),
      capturedAt,
    });
  }

  return Object.freeze({
    kind: "manual" as const,
    enteredBy: toReferenceText(
      "enteredBy",
      (input as ManualCostSourceInput).enteredBy,
    ),
    capturedAt,
  });
}

/** The capture instant as a new `Date`; mutating it cannot alter the reference. */
export function capturedAtInstant(source: CostSourceReference): Date {
  return new Date(source.capturedAt);
}
