import { looksLikeSecret } from "@/modules/ai-costs/source";

/**
 * Agent run contract (M13-02). Pure, no I/O.
 *
 * Metadata only: the contract is closed, so a payload carrying a prompt, a
 * completion or any other unknown field is refused rather than silently stored
 * (content capture needs the opt-in of M18-03).
 *
 * Unknown is not zero: an absent or `null` field stays unknown. On re-ingestion it
 * leaves the stored value untouched, so a later, thinner report never erases data.
 */

export const AGENT_RUN_RESULTS = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type AgentRunResult = (typeof AGENT_RUN_RESULTS)[number];

/** Fields a complete run reports; any of them unknown makes the run partial. */
export const RUN_TRACKED_FIELDS = [
  "traceId",
  "startedAt",
  "endedAt",
  "inputTokens",
  "outputTokens",
  "retries",
  "toolCalls",
  "result",
  "initiator",
] as const;
export type RunTrackedField = (typeof RUN_TRACKED_FIELDS)[number];

export const MAX_RUNS_PER_INGESTION = 500;
export const MAX_DELIVERY_LINKS = 20;
export const MAX_COST_LINKS = 100;
const MAX_REFERENCE_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_KEYS = new Set<string>([
  "externalRef",
  "agentVersionId",
  "deliveryLinks",
  "costEntryIds",
  ...RUN_TRACKED_FIELDS,
]);

export class InvalidAgentRunError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid agent run ${field}: ${reason}`);
    this.name = "InvalidAgentRunError";
  }
}

export type AgentRunInput = Record<string, unknown>;

/** `undefined` means unknown: not written on create, not overwritten on update. */
export type AgentRunWrite = {
  readonly externalRef: string;
  readonly agentVersionId: string;
  readonly traceId?: string;
  readonly startedAt?: Date;
  readonly endedAt?: Date;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly retries?: number;
  readonly toolCalls?: number;
  readonly result?: AgentRunResult;
  readonly initiator?: string;
  /** Added to the stored links, never replacing them. */
  readonly deliveryLinks: readonly string[];
  /** Added to the stored cost links, never replacing them. */
  readonly costEntryIds: readonly string[];
};

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function reference(value: unknown, field: string): string {
  if (typeof value !== "string") throw new InvalidAgentRunError(field, "expected text");

  const trimmed = value.trim();
  if (trimmed === "") throw new InvalidAgentRunError(field, "is empty");
  if (trimmed.length > MAX_REFERENCE_LENGTH) {
    throw new InvalidAgentRunError(field, `at most ${MAX_REFERENCE_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) throw new InvalidAgentRunError(field, "contains control characters");
  if (looksLikeSecret(trimmed)) throw new InvalidAgentRunError(field, "looks like a credential");

  return trimmed;
}

function instant(value: unknown, field: string): Date {
  const date =
    value instanceof Date ? value : typeof value === "string" && ISO_INSTANT.test(value) ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    throw new InvalidAgentRunError(field, "expected an ISO 8601 instant with a time zone");
  }

  return date;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new InvalidAgentRunError(field, "expected a non-negative integer");
  }

  return value;
}

function deliveryLink(value: unknown, index: number): string {
  const field = `deliveryLinks[${index}]`;
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) throw new InvalidAgentRunError(field, "expected a URL");

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidAgentRunError(field, "expected a URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidAgentRunError(field, "expected http(s)");
  if (url.username || url.password || looksLikeSecret(url.href)) {
    throw new InvalidAgentRunError(field, "must not carry credentials");
  }

  return url.href;
}

function list<T>(value: unknown, field: string, max: number, item: (value: unknown, index: number) => T): T[] {
  if (absent(value)) return [];
  if (!Array.isArray(value)) throw new InvalidAgentRunError(field, "expected a list");
  if (value.length > max) throw new InvalidAgentRunError(field, `at most ${max} items`);
  return [...new Set(value.map(item))];
}

/** Validates one run report into its storable form. */
export function validateAgentRun(input: AgentRunInput): AgentRunWrite {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidAgentRunError("run", "expected an object");
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) throw new InvalidAgentRunError(key, "is not part of the run metadata contract");
  }

  const optional = <T>(key: string, parse: (value: unknown, field: string) => T): T | undefined =>
    absent(input[key]) ? undefined : parse(input[key], key);

  const startedAt = optional("startedAt", instant);
  const endedAt = optional("endedAt", instant);
  if (startedAt && endedAt && endedAt < startedAt) {
    throw new InvalidAgentRunError("endedAt", "is before startedAt");
  }

  return {
    externalRef: reference(input.externalRef, "externalRef"),
    agentVersionId: reference(input.agentVersionId, "agentVersionId"),
    traceId: optional("traceId", reference),
    startedAt,
    endedAt,
    inputTokens: optional("inputTokens", count),
    outputTokens: optional("outputTokens", count),
    retries: optional("retries", count),
    toolCalls: optional("toolCalls", count),
    result: optional("result", (value, field) => {
      if (typeof value !== "string" || !(AGENT_RUN_RESULTS as readonly string[]).includes(value)) {
        throw new InvalidAgentRunError(field, "unknown result");
      }
      return value as AgentRunResult;
    }),
    initiator: optional("initiator", reference),
    deliveryLinks: list(input.deliveryLinks, "deliveryLinks", MAX_DELIVERY_LINKS, deliveryLink),
    costEntryIds: list(input.costEntryIds, "costEntryIds", MAX_COST_LINKS, (value, index) =>
      reference(value, `costEntryIds[${index}]`),
    ),
  };
}

/** Tracked fields still unknown on a stored run; empty means the run is complete. */
export function missingRunFields(run: Readonly<Record<RunTrackedField, unknown>>): RunTrackedField[] {
  return RUN_TRACKED_FIELDS.filter((field) => run[field] === null || run[field] === undefined);
}
