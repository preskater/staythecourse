import Decimal from "decimal.js";
import type { Prisma } from "@/generated/prisma/client";
import { parseDateOnly, toDateOnlyString } from "@/lib/dates";
import { getPrisma } from "@/lib/db";
import { money, type Currency } from "@/lib/money";
import {
  assertAllocationConservation,
  assertAllocationSigns,
  fromCents,
  toCents,
} from "./allocation";
import {
  fromCostDimensionColumns,
  toCostDimensionColumns,
} from "./dimensions";
import {
  assertCostEntryEditable,
  CostEntryNotFoundError,
  fromStoredActuality,
  InvalidCostEntryError,
  prepareCostAllocation,
  prepareCostAllocationUpdate,
  toStoredActuality,
  validateCostAllocationShape,
  validateCostAllocationUpdateShape,
  validateCostEntryInput,
  type CostAllocation,
  type CostAllocationInput,
  type CostAllocationUpdateInput,
  type CostEntry,
  type CostEntryInput,
  type CostEntryLedger,
  type CostEntryStatus,
  type CostEntryTotals,
} from "./ledger";
import { costMoney } from "./money";
import {
  createCostSource,
  type CostSourceReference,
} from "./source";

/**
 * Cost ledger persistence (M9-02).
 *
 * Every function is workspace-scoped. `CostAllocation` is a child table with no
 * `workspaceId` of its own (see `docs/architecture/workspace-scoping.md`): it is
 * reachable only through its entry, so a foreign entry identifier reads as "not
 * found" and a foreign allocation can never be written.
 *
 * Writes that change an entry lock its row (`SELECT ... FOR UPDATE`) before
 * re-reading the status. A finalization and an allocation therefore cannot
 * interleave: once the entry is FINALIZED, every later write sees it and refuses.
 */

export type CostEntryFilters = {
  status?: CostEntryStatus;
  /** Entries whose period overlaps `[from, to]`, bounds included. */
  from?: Date | string;
  to?: Date | string;
  projectId?: string;
  clientId?: string;
  repository?: string;
  take?: number;
};

export const COST_ENTRY_PAGE_SIZE = 200;
const MAX_COST_ENTRY_PAGE_SIZE = 500;

type CostEntryRow = {
  id: string;
  workspaceId: string;
  amount: Decimal.Value;
  currency: string;
  actuality: string;
  sourceKind: string;
  sourceProvider: string | null;
  sourceExternalId: string | null;
  sourceImportId: string | null;
  sourceRowNumber: number | null;
  sourceEnteredBy: string | null;
  sourceCapturedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  notes: string | null;
  projectId: string | null;
  clientId: string | null;
  repository: string | null;
  developerId: string | null;
  agentId: string | null;
  issueId: string | null;
  pullRequestId: string | null;
  environment: string | null;
  tags: string[];
  status: string;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type CostAllocationRow = {
  id: string;
  entryId: string;
  amount: Decimal.Value;
  projectId: string | null;
  clientId: string | null;
  repository: string | null;
  developerId: string | null;
  agentId: string | null;
  issueId: string | null;
  pullRequestId: string | null;
  environment: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

type AmountRow = { amount: Decimal.Value };

const COST_ENTRY_SELECT = {
  id: true,
  workspaceId: true,
  amount: true,
  currency: true,
  actuality: true,
  sourceKind: true,
  sourceProvider: true,
  sourceExternalId: true,
  sourceImportId: true,
  sourceRowNumber: true,
  sourceEnteredBy: true,
  sourceCapturedAt: true,
  periodStart: true,
  periodEnd: true,
  notes: true,
  projectId: true,
  clientId: true,
  repository: true,
  developerId: true,
  agentId: true,
  issueId: true,
  pullRequestId: true,
  environment: true,
  tags: true,
  status: true,
  finalizedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const COST_ENTRY_MONEY_SELECT = {
  id: true,
  amount: true,
  currency: true,
  status: true,
} as const;

const COST_ALLOCATION_SELECT = {
  id: true,
  entryId: true,
  amount: true,
  projectId: true,
  clientId: true,
  repository: true,
  developerId: true,
  agentId: true,
  issueId: true,
  pullRequestId: true,
  environment: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toStatus(value: string): CostEntryStatus {
  if (value !== "DRAFT" && value !== "FINALIZED") {
    throw new Error("Unknown stored cost entry status.");
  }

  return value;
}

function sourceFromRow(row: CostEntryRow): CostSourceReference {
  const capturedAt = row.sourceCapturedAt;

  switch (row.sourceKind) {
    case "PROVIDER":
      if (!row.sourceProvider || !row.sourceExternalId) {
        throw new Error("Stored cost source is incomplete.");
      }

      return createCostSource({
        kind: "provider",
        provider: row.sourceProvider,
        externalId: row.sourceExternalId,
        capturedAt,
      });
    case "IMPORT":
      if (!row.sourceImportId || row.sourceRowNumber === null) {
        throw new Error("Stored cost source is incomplete.");
      }

      return createCostSource({
        kind: "import",
        importId: row.sourceImportId,
        rowNumber: row.sourceRowNumber,
        capturedAt,
      });
    case "MANUAL":
      if (!row.sourceEnteredBy) {
        throw new Error("Stored cost source is incomplete.");
      }

      return createCostSource({
        kind: "manual",
        enteredBy: row.sourceEnteredBy,
        capturedAt,
      });
    default:
      throw new Error("Unknown stored cost source kind.");
  }
}

function sourceColumns(source: CostSourceReference) {
  const capturedAt = new Date(source.capturedAt);

  switch (source.kind) {
    case "provider":
      return {
        sourceKind: "PROVIDER" as const,
        sourceProvider: source.provider,
        sourceExternalId: source.externalId,
        sourceImportId: null,
        sourceRowNumber: null,
        sourceEnteredBy: null,
        sourceCapturedAt: capturedAt,
      };
    case "import":
      return {
        sourceKind: "IMPORT" as const,
        sourceProvider: null,
        sourceExternalId: null,
        sourceImportId: source.importId,
        sourceRowNumber: source.rowNumber,
        sourceEnteredBy: null,
        sourceCapturedAt: capturedAt,
      };
    case "manual":
      return {
        sourceKind: "MANUAL" as const,
        sourceProvider: null,
        sourceExternalId: null,
        sourceImportId: null,
        sourceRowNumber: null,
        sourceEnteredBy: source.enteredBy,
        sourceCapturedAt: capturedAt,
      };
  }
}

function toCostEntry(row: CostEntryRow): CostEntry {
  return {
    id: row.id,
    amount: costMoney(row.amount, row.currency),
    actuality: fromStoredActuality(row.actuality),
    source: sourceFromRow(row),
    periodStart: toDateOnlyString(row.periodStart),
    periodEnd: toDateOnlyString(row.periodEnd),
    notes: row.notes,
    dimensions: fromCostDimensionColumns(row),
    status: toStatus(row.status),
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCostAllocation(row: CostAllocationRow, currency: Currency): CostAllocation {
  return {
    id: row.id,
    entryId: row.entryId,
    amount: costMoney(row.amount, currency),
    dimensions: fromCostDimensionColumns(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function entryData(validated: ReturnType<typeof validateCostEntryInput>) {
  return {
    amount: validated.amount.amount.toFixed(2),
    currency: validated.amount.currency,
    actuality: toStoredActuality(validated.actuality),
    ...sourceColumns(validated.source),
    periodStart: parseDateOnly(validated.periodStart),
    periodEnd: parseDateOnly(validated.periodEnd),
    notes: validated.notes,
    ...toCostDimensionColumns(validated.dimensions),
  };
}

function allocationData(
  validated: ReturnType<typeof prepareCostAllocation>,
  entryId: string,
) {
  return {
    entryId,
    amount: validated.amount.amount.toFixed(2),
    ...toCostDimensionColumns(validated.dimensions),
  };
}

function assertRowsConserve(entryAmount: Decimal.Value, rows: readonly AmountRow[]): void {
  const totalCents = toCents(new Decimal(entryAmount.toString()));
  const allocated = rows.map((row) => toCents(new Decimal(row.amount.toString())));

  assertAllocationSigns(totalCents, allocated);
  assertAllocationConservation(
    totalCents,
    allocated.reduce((sum, cents) => sum + cents, BigInt(0)),
  );
}

function totalsOf(entry: CostEntry, allocations: readonly CostAllocation[]): CostEntryTotals {
  const totalCents = toCents(entry.amount.amount);
  const allocatedCents = allocations.map((allocation) =>
    toCents(allocation.amount.amount),
  );

  assertAllocationSigns(totalCents, allocatedCents);
  const summary = assertAllocationConservation(
    totalCents,
    allocatedCents.reduce((sum, cents) => sum + cents, BigInt(0)),
  );

  return {
    total: entry.amount,
    allocated: money(fromCents(summary.allocatedCents), entry.amount.currency),
    unallocated: money(fromCents(summary.unallocatedCents), entry.amount.currency),
  };
}

function toFilterDate(value: Date | string): Date {
  return value instanceof Date ? value : parseDateOnly(value);
}

function allocationOrderBy() {
  return [{ createdAt: "asc" as const }, { id: "asc" as const }];
}

async function findEntryMoney(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  entryId: string,
): Promise<{ id: string; amount: Decimal.Value; currency: string; status: string } | null> {
  const row = await tx.costEntry.findFirst({
    where: { id: entryId, workspaceId },
    select: COST_ENTRY_MONEY_SELECT,
  });

  return (row as { id: string; amount: Decimal.Value; currency: string; status: string } | null);
}

async function lockEntry(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  entryId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "CostEntry" WHERE "id" = ${entryId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
}

export async function listCostEntries(
  workspaceId: string,
  filters: CostEntryFilters = {},
): Promise<CostEntry[]> {
  const take = Math.min(
    Math.max(filters.take ?? COST_ENTRY_PAGE_SIZE, 1),
    MAX_COST_ENTRY_PAGE_SIZE,
  );
  const rows = (await getPrisma().costEntry.findMany({
    where: {
      workspaceId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.repository ? { repository: filters.repository } : {}),
      ...(filters.to ? { periodStart: { lte: toFilterDate(filters.to) } } : {}),
      ...(filters.from ? { periodEnd: { gte: toFilterDate(filters.from) } } : {}),
    },
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take,
    select: COST_ENTRY_SELECT,
  })) as CostEntryRow[];

  return rows.map(toCostEntry);
}

export async function findCostEntry(
  workspaceId: string,
  entryId: string,
): Promise<CostEntry | null> {
  const row = (await getPrisma().costEntry.findFirst({
    where: { id: entryId, workspaceId },
    select: COST_ENTRY_SELECT,
  })) as CostEntryRow | null;

  return row ? toCostEntry(row) : null;
}

export async function createCostEntry(
  workspaceId: string,
  input: CostEntryInput,
): Promise<CostEntry> {
  const validated = validateCostEntryInput(input);
  const row = (await getPrisma().costEntry.create({
    data: { workspaceId, ...entryData(validated) },
    select: COST_ENTRY_SELECT,
  })) as CostEntryRow;

  return toCostEntry(row);
}

/**
 * Replaces a draft entry. Returns `false` when the entry is not in this workspace;
 * throws `FinalizedCostEntryError` when it is already finalized.
 */
export async function updateCostEntry(
  workspaceId: string,
  entryId: string,
  input: CostEntryInput,
): Promise<boolean> {
  const validated = validateCostEntryInput(input);

  return getPrisma().$transaction(async (tx) => {
    const found = await findEntryMoney(tx, workspaceId, entryId);

    if (!found) {
      return false;
    }

    assertCostEntryEditable(toStatus(found.status));
    await lockEntry(tx, workspaceId, entryId);

    const current = await findEntryMoney(tx, workspaceId, entryId);

    if (!current) {
      return false;
    }

    assertCostEntryEditable(toStatus(current.status));

    const allocations = (await tx.costAllocation.findMany({
      where: { entryId },
      select: { amount: true },
    })) as AmountRow[];

    if (
      allocations.length > 0 &&
      validated.amount.currency !== current.currency
    ) {
      throw new InvalidCostEntryError(
        "currency",
        "cannot change the currency of an entry that already has allocations",
      );
    }

    assertRowsConserve(validated.amount.amount, allocations);

    const { count } = await tx.costEntry.updateMany({
      where: { id: entryId, workspaceId, status: "DRAFT" },
      data: entryData(validated),
    });

    return count === 1;
  });
}

/** Deletes a draft entry and, by cascade, its allocations. */
export async function deleteCostEntry(
  workspaceId: string,
  entryId: string,
): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    const found = await findEntryMoney(tx, workspaceId, entryId);

    if (!found) {
      return false;
    }

    assertCostEntryEditable(toStatus(found.status));
    await lockEntry(tx, workspaceId, entryId);

    const current = await findEntryMoney(tx, workspaceId, entryId);

    if (!current) {
      return false;
    }

    assertCostEntryEditable(toStatus(current.status));

    const { count } = await tx.costEntry.deleteMany({
      where: { id: entryId, workspaceId },
    });

    return count === 1;
  });
}

/**
 * Locks the entry and its allocations. Already finalized is a success: the
 * operation is idempotent, and no row changes on the second call.
 */
export async function finalizeCostEntry(
  workspaceId: string,
  entryId: string,
): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    const found = await findEntryMoney(tx, workspaceId, entryId);

    if (!found) {
      return false;
    }

    if (toStatus(found.status) === "FINALIZED") {
      return true;
    }

    await lockEntry(tx, workspaceId, entryId);

    const current = await findEntryMoney(tx, workspaceId, entryId);

    if (!current) {
      return false;
    }

    if (toStatus(current.status) === "FINALIZED") {
      return true;
    }

    const allocations = (await tx.costAllocation.findMany({
      where: { entryId },
      select: { amount: true },
    })) as AmountRow[];
    assertRowsConserve(current.amount, allocations);

    const { count } = await tx.costEntry.updateMany({
      where: { id: entryId, workspaceId, status: "DRAFT" },
      data: { status: "FINALIZED", finalizedAt: new Date() },
    });

    if (count === 1) {
      return true;
    }

    const after = await findEntryMoney(tx, workspaceId, entryId);
    return after !== null && toStatus(after.status) === "FINALIZED";
  });
}

/**
 * Lists one entry's allocations. `null` means the entry is not in this workspace,
 * which is distinct from an entry that simply has no allocation.
 */
export async function listCostAllocations(
  workspaceId: string,
  entryId: string,
): Promise<CostAllocation[] | null> {
  const entry = await findCostEntry(workspaceId, entryId);

  if (!entry) {
    return null;
  }

  const rows = (await getPrisma().costAllocation.findMany({
    where: { entryId },
    orderBy: allocationOrderBy(),
    select: COST_ALLOCATION_SELECT,
  })) as CostAllocationRow[];

  return rows.map((row) => toCostAllocation(row, entry.amount.currency));
}

/** The entry, its allocations and the derived total / allocated / unallocated split. */
export async function getCostEntryLedger(
  workspaceId: string,
  entryId: string,
): Promise<CostEntryLedger | null> {
  const entry = await findCostEntry(workspaceId, entryId);

  if (!entry) {
    return null;
  }

  const rows = (await getPrisma().costAllocation.findMany({
    where: { entryId },
    orderBy: allocationOrderBy(),
    select: COST_ALLOCATION_SELECT,
  })) as CostAllocationRow[];
  const allocations = rows.map((row) => toCostAllocation(row, entry.amount.currency));

  return { entry, allocations, totals: totalsOf(entry, allocations) };
}

/**
 * Adds one allocation. A foreign entry identifier throws rather than creating an
 * orphan, and a finalized entry refuses every new allocation.
 */
export async function createCostAllocation(
  workspaceId: string,
  input: CostAllocationInput,
): Promise<CostAllocation> {
  const shape = validateCostAllocationShape(input);

  return getPrisma().$transaction(async (tx) => {
    const found = await findEntryMoney(tx, workspaceId, shape.entryId);

    if (!found) {
      throw new CostEntryNotFoundError();
    }

    assertCostEntryEditable(toStatus(found.status));
    await lockEntry(tx, workspaceId, shape.entryId);

    const current = await findEntryMoney(tx, workspaceId, shape.entryId);

    if (!current) {
      throw new CostEntryNotFoundError();
    }

    assertCostEntryEditable(toStatus(current.status));

    const validated = prepareCostAllocation(input, current.currency);
    const existing = (await tx.costAllocation.findMany({
      where: { entryId: shape.entryId },
      select: { amount: true },
    })) as AmountRow[];

    assertRowsConserve(current.amount, [
      ...existing,
      { amount: validated.amount.amount },
    ]);

    const row = (await tx.costAllocation.create({
      data: allocationData(validated, shape.entryId),
      select: COST_ALLOCATION_SELECT,
    })) as CostAllocationRow;

    return toCostAllocation(row, current.currency as Currency);
  });
}

/** Replaces an allocation's amount and dimensions; `false` means not found here. */
export async function updateCostAllocation(
  workspaceId: string,
  allocationId: string,
  input: CostAllocationUpdateInput,
): Promise<boolean> {
  validateCostAllocationUpdateShape(input);

  return getPrisma().$transaction(async (tx) => {
    const found = (await tx.costAllocation.findFirst({
      where: { id: allocationId, entry: { workspaceId } },
      select: { id: true, entryId: true },
    })) as { id: string; entryId: string } | null;

    if (!found) {
      return false;
    }

    const entry = await findEntryMoney(tx, workspaceId, found.entryId);

    if (!entry) {
      return false;
    }

    assertCostEntryEditable(toStatus(entry.status));
    await lockEntry(tx, workspaceId, found.entryId);

    const current = (await tx.costAllocation.findFirst({
      where: { id: allocationId, entry: { workspaceId } },
      select: { id: true, entryId: true },
    })) as { id: string; entryId: string } | null;

    if (!current) {
      return false;
    }

    const currentEntry = await findEntryMoney(tx, workspaceId, current.entryId);

    if (!currentEntry) {
      return false;
    }

    assertCostEntryEditable(toStatus(currentEntry.status));

    const validated = prepareCostAllocationUpdate(input, currentEntry.currency);
    const others = (await tx.costAllocation.findMany({
      where: { entryId: current.entryId, id: { not: allocationId } },
      select: { amount: true },
    })) as AmountRow[];

    assertRowsConserve(currentEntry.amount, [
      ...others,
      { amount: validated.amount.amount },
    ]);

    const { count } = await tx.costAllocation.updateMany({
      where: { id: allocationId },
      data: {
        amount: validated.amount.amount.toFixed(2),
        ...toCostDimensionColumns(validated.dimensions),
      },
    });

    return count === 1;
  });
}

/** Deletes an allocation; `false` means it does not exist in this workspace. */
export async function deleteCostAllocation(
  workspaceId: string,
  allocationId: string,
): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    const found = (await tx.costAllocation.findFirst({
      where: { id: allocationId, entry: { workspaceId } },
      select: { id: true, entryId: true },
    })) as { id: string; entryId: string } | null;

    if (!found) {
      return false;
    }

    const entry = await findEntryMoney(tx, workspaceId, found.entryId);

    if (!entry) {
      return false;
    }

    assertCostEntryEditable(toStatus(entry.status));
    await lockEntry(tx, workspaceId, found.entryId);

    const current = (await tx.costAllocation.findFirst({
      where: { id: allocationId, entry: { workspaceId } },
      select: { id: true, entryId: true },
    })) as { id: string; entryId: string } | null;

    if (!current) {
      return false;
    }

    const currentEntry = await findEntryMoney(tx, workspaceId, current.entryId);

    if (!currentEntry) {
      return false;
    }

    assertCostEntryEditable(toStatus(currentEntry.status));

    const { count } = await tx.costAllocation.deleteMany({
      where: { id: allocationId },
    });

    return count === 1;
  });
}
