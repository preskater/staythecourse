import Decimal from "decimal.js";
import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { parseDateOnly } from "@/lib/dates";
import {
  assertExchangeRatePair,
  createExchangeRate,
  createExchangeRateSnapshot,
  parseRateDate,
  RATE_DECIMALS,
  type ExchangeRateInput,
  type ExchangeRateSnapshot,
} from "./exchange";
import type { CostSourceInput } from "./source";

/**
 * Exchange-rate snapshot persistence (M9-04).
 *
 * There is no update and no delete, on purpose: a snapshot is the evidence behind a
 * converted figure. Recording a rate again — a correction, or a rate observed later the
 * same day — inserts a new row; rows already referenced by a conversion are untouched,
 * so history never moves. `recordedAt` breaks a tie between two snapshots of one day,
 * and the identifier breaks a tie between two written in the same millisecond.
 *
 * Rates have no live feed here: they are entered through `recordExchangeRate` (a manual
 * entry today, an import when M9-05 lands) and always scoped to a workspace like the
 * rest of the ledger.
 */

const EXCHANGE_RATE_SELECT = {
  id: true,
  baseCurrency: true,
  quoteCurrency: true,
  rate: true,
  rateDate: true,
  source: true,
  recordedAt: true,
} as const;

const DEFAULT_LIST_SIZE = 100;
const MAX_LIST_SIZE = 500;

/** Declared structurally, so the mapper does not depend on the generated client type. */
type ExchangeRateRow = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: Decimal | string;
  rateDate: Date;
  source: unknown;
  recordedAt: Date;
};

/**
 * Rebuilds a snapshot from a row.
 *
 * The row is re-validated through the domain constructors: a rate of zero, an
 * unsupported currency or a token-shaped source fails loudly here instead of feeding a
 * conversion with a value the application would never have written.
 */
function toSnapshot(row: ExchangeRateRow): ExchangeRateSnapshot {
  return createExchangeRateSnapshot({
    id: row.id,
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rate: new Decimal(row.rate.toString()),
    rateDate: row.rateDate,
    source: row.source as CostSourceInput,
    recordedAt: row.recordedAt,
  });
}

function assertWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid exchange rate workspaceId: expected an identifier.");
  }

  return value.trim();
}

export type RecordExchangeRateInput = ExchangeRateInput & {
  /** Resolved from the session's memberships, never from the browser. */
  workspaceId: string;
};

/**
 * Records a rate snapshot and returns it with its identifier.
 *
 * Nothing is rounded on the way in: the rate is written exactly as validated by
 * `createExchangeRate`, and the whole input is rejected before any write if it is
 * invalid.
 */
export async function recordExchangeRate(
  input: RecordExchangeRateInput,
): Promise<ExchangeRateSnapshot> {
  const workspaceId = assertWorkspaceId(input.workspaceId);
  const rate = createExchangeRate(input);

  const row = await getPrisma().exchangeRateSnapshot.create({
    data: {
      workspaceId,
      baseCurrency: rate.baseCurrency,
      quoteCurrency: rate.quoteCurrency,
      rate: rate.rate.toFixed(RATE_DECIMALS),
      rateDate: parseDateOnly(rate.rateDate),
      source: rate.source as unknown as Prisma.InputJsonObject,
      recordedAt: new Date(rate.recordedAt),
    },
    select: EXCHANGE_RATE_SELECT,
  });

  return toSnapshot(row as ExchangeRateRow);
}

/** Owner-scoped lookup by identifier: an identifier from a URL is never trusted. */
export async function findExchangeRateSnapshotById(
  workspaceId: string,
  id: string,
): Promise<ExchangeRateSnapshot | null> {
  const row = await getPrisma().exchangeRateSnapshot.findFirst({
    where: { id, workspaceId: assertWorkspaceId(workspaceId) },
    select: EXCHANGE_RATE_SELECT,
  });

  return row ? toSnapshot(row as ExchangeRateRow) : null;
}

export type ExchangeRateQuery = {
  baseCurrency: string;
  quoteCurrency: string;
  /**
   * Calendar day of the amount being normalised (`YYYY-MM-DD`, or a `Date` read in UTC).
   * The latest snapshot dated on or before it is used; omit for the latest known.
   */
  asOf?: Date | string;
};

/**
 * The rate in force for one pair, for one day.
 *
 * Resolution is deterministic: the most recent `rateDate` wins, then the most recently
 * recorded snapshot of that day, then the highest identifier. A day before the first
 * snapshot of the pair has **no** rate — the caller keeps the amount unknown rather
 * than converting it with a later rate.
 */
export async function findExchangeRateSnapshot(
  workspaceId: string,
  query: ExchangeRateQuery,
): Promise<ExchangeRateSnapshot | null> {
  const { baseCurrency, quoteCurrency } = assertExchangeRatePair(
    query.baseCurrency,
    query.quoteCurrency,
  );
  const asOf =
    query.asOf === undefined ? null : parseDateOnly(parseRateDate(query.asOf));

  const row = await getPrisma().exchangeRateSnapshot.findFirst({
    where: {
      workspaceId: assertWorkspaceId(workspaceId),
      baseCurrency,
      quoteCurrency,
      ...(asOf ? { rateDate: { lte: asOf } } : {}),
    },
    orderBy: [{ rateDate: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
    select: EXCHANGE_RATE_SELECT,
  });

  return row ? toSnapshot(row as ExchangeRateRow) : null;
}

export type ExchangeRateListOptions = {
  /** Restrict the list to one pair; both currency codes are required together. */
  pair?: { baseCurrency: string; quoteCurrency: string };
  /** Newest first, between 1 and `MAX_LIST_SIZE` (100 by default). */
  take?: number;
};

/** The workspace's snapshots, newest first — the history a converted figure came from. */
export async function listExchangeRates(
  workspaceId: string,
  options: ExchangeRateListOptions = {},
): Promise<ExchangeRateSnapshot[]> {
  const pair = options.pair
    ? assertExchangeRatePair(
        options.pair.baseCurrency,
        options.pair.quoteCurrency,
      )
    : null;
  const take = Math.min(
    Math.max(Math.trunc(options.take ?? DEFAULT_LIST_SIZE), 1),
    MAX_LIST_SIZE,
  );

  const rows = await getPrisma().exchangeRateSnapshot.findMany({
    where: {
      workspaceId: assertWorkspaceId(workspaceId),
      ...(pair ?? {}),
    },
    orderBy: [{ rateDate: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
    take,
    select: EXCHANGE_RATE_SELECT,
  });

  return rows.map((row) => toSnapshot(row as ExchangeRateRow));
}
