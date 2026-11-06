import { looksLikeSecret } from "./source";

/**
 * The dimensions a cost can be attached to (M9-02).
 *
 * Identifiers are deliberately opaque strings: projects, clients, developers and
 * agents get their own tables in a later milestone, and the ledger must not wait
 * for them. Every field is nullable — an entry can be recorded before its
 * dimensions are known, and an allocation names only the dimensions it splits
 * into. `tags` is a free-form set for everything the typed dimensions do not cover.
 */
export const COST_DIMENSION_KEYS = [
  "projectId",
  "clientId",
  "repository",
  "developerId",
  "agentId",
  "issueId",
  "pullRequestId",
  "environment",
] as const;

export type CostDimensionKey = (typeof COST_DIMENSION_KEYS)[number];

export type CostDimensionsInput = Partial<
  Record<CostDimensionKey, string | null | undefined>
> & {
  tags?: readonly string[] | null;
};

export type CostDimensions = Readonly<
  Record<CostDimensionKey, string | null> & {
    readonly tags: readonly string[];
  }
>;

export type CostDimensionColumns = Record<CostDimensionKey, string | null> & {
  tags: string[];
};

export const EMPTY_COST_DIMENSIONS: CostDimensions = Object.freeze({
  projectId: null,
  clientId: null,
  repository: null,
  developerId: null,
  agentId: null,
  issueId: null,
  pullRequestId: null,
  environment: null,
  tags: Object.freeze([]) as readonly string[],
});

export const MAX_COST_TAG_COUNT = 32;

const MAX_DIMENSION_LENGTH = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export class InvalidCostDimensionError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid cost dimension ${field}: ${reason}`);
    this.name = "InvalidCostDimensionError";
  }
}

/**
 * A dimension must never carry a credential. The message names the field only:
 * echoing the rejected value would copy a secret into logs and error captures.
 */
export class UnsafeCostDimensionError extends Error {
  constructor(readonly field: string) {
    super(
      `Unsafe cost dimension ${field}: identifiers must not contain a secret or a token.`,
    );
    this.name = "UnsafeCostDimensionError";
  }
}

function toDimensionValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new InvalidCostDimensionError(field, "expected a string or null");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_DIMENSION_LENGTH) {
    throw new InvalidCostDimensionError(
      field,
      `expected between 1 and ${MAX_DIMENSION_LENGTH} characters`,
    );
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidCostDimensionError(field, "control characters are not allowed");
  }

  if (looksLikeSecret(trimmed)) {
    throw new UnsafeCostDimensionError(field);
  }

  return trimmed;
}

function toTags(value: unknown): readonly string[] {
  if (value === null || value === undefined) {
    return Object.freeze([]) as readonly string[];
  }

  if (!Array.isArray(value)) {
    throw new InvalidCostDimensionError("tags", "expected an array of strings");
  }

  if (value.length > MAX_COST_TAG_COUNT) {
    throw new InvalidCostDimensionError(
      "tags",
      `expected at most ${MAX_COST_TAG_COUNT} tags`,
    );
  }

  const tags = new Set<string>();

  for (const item of value) {
    const tag = toDimensionValue("tags", item);

    if (tag !== null) {
      tags.add(tag);
    }
  }

  return Object.freeze(
    [...tags].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/**
 * Normalises a partial dimension set. Missing and `null` values become `null`;
 * tags are trimmed, de-duplicated and sorted so two equal sets compare equal.
 */
export function normalizeCostDimensions(
  input: CostDimensionsInput | null | undefined,
): CostDimensions {
  if (input === null || input === undefined) {
    return EMPTY_COST_DIMENSIONS;
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidCostDimensionError("dimensions", "expected an object");
  }

  const source = input as Record<string, unknown>;
  const values = Object.fromEntries(
    COST_DIMENSION_KEYS.map((key) => [key, toDimensionValue(key, source[key])]),
  ) as Record<CostDimensionKey, string | null>;

  return Object.freeze({
    ...values,
    tags: toTags(source.tags),
  });
}

/** True when at least one typed dimension or tag is set. */
export function hasCostDimension(dimensions: CostDimensions): boolean {
  return (
    COST_DIMENSION_KEYS.some((key) => dimensions[key] !== null) ||
    dimensions.tags.length > 0
  );
}

/** Mutable copy shaped like the Prisma columns. */
export function toCostDimensionColumns(
  dimensions: CostDimensions,
): CostDimensionColumns {
  return {
    projectId: dimensions.projectId,
    clientId: dimensions.clientId,
    repository: dimensions.repository,
    developerId: dimensions.developerId,
    agentId: dimensions.agentId,
    issueId: dimensions.issueId,
    pullRequestId: dimensions.pullRequestId,
    environment: dimensions.environment,
    tags: [...dimensions.tags],
  };
}

/** Rebuilds and re-validates the dimensions read from the database. */
export function fromCostDimensionColumns(
  row: Partial<CostDimensionsInput> | null | undefined,
): CostDimensions {
  return normalizeCostDimensions(row);
}
