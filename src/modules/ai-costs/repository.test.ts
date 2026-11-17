import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAllocationConservation,
  InvalidAllocationMathError,
} from "./allocation";
import {
  CostEntryNotFoundError,
  FinalizedCostEntryError,
  InvalidCostEntryError,
  type CostEntryInput,
} from "./ledger";

type EntryRow = {
  id: string;
  workspaceId: string;
  amount: Decimal;
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

type AllocationRow = {
  id: string;
  entryId: string;
  amount: Decimal;
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

const NOW = new Date("2026-03-15T12:00:00.000Z");
const LATER = new Date("2026-03-15T12:00:01.000Z");

let entries = new Map<string, EntryRow>();
let allocations = new Map<string, AllocationRow>();
let entrySequence = 0;
let allocationSequence = 0;

function makeEntryRow(overrides: Partial<EntryRow> = {}): EntryRow {
  entrySequence += 1;

  return {
    id: `entry-${entrySequence}`,
    workspaceId: "ws-1",
    amount: new Decimal("100.00"),
    currency: "EUR",
    actuality: "OBSERVED",
    sourceKind: "MANUAL",
    sourceProvider: null,
    sourceExternalId: null,
    sourceImportId: null,
    sourceRowNumber: null,
    sourceEnteredBy: "owner-1",
    sourceCapturedAt: new Date("2026-03-01T00:00:00.000Z"),
    periodStart: new Date("2026-03-01T00:00:00.000Z"),
    periodEnd: new Date("2026-03-31T00:00:00.000Z"),
    notes: null,
    projectId: null,
    clientId: null,
    repository: null,
    developerId: null,
    agentId: null,
    issueId: null,
    pullRequestId: null,
    environment: null,
    tags: [],
    status: "DRAFT",
    finalizedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAllocationRow(overrides: Partial<AllocationRow> = {}): AllocationRow {
  allocationSequence += 1;

  return {
    id: `allocation-${allocationSequence}`,
    entryId: "entry-1",
    amount: new Decimal("10.00"),
    projectId: null,
    clientId: null,
    repository: null,
    developerId: null,
    agentId: null,
    issueId: null,
    pullRequestId: null,
    environment: null,
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown> = {},
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) {
      return true;
    }

    if (key === "entry") {
      const entry = entries.get(String(row.entryId));
      return entry ? matchesWhere(entry as Record<string, unknown>, expected as Record<string, unknown>) : false;
    }

    const actual = row[key];

    if (expected instanceof Date) {
      return actual instanceof Date && actual.getTime() === expected.getTime();
    }

    if (
      typeof expected === "object" &&
      expected !== null &&
      !(expected instanceof Decimal)
    ) {
      const operator = expected as Record<string, unknown>;

      if ("not" in operator) {
        return actual !== operator.not;
      }

      if ("lte" in operator && actual instanceof Date) {
        return actual.getTime() <= (operator.lte as Date).getTime();
      }

      if ("gte" in operator && actual instanceof Date) {
        return actual.getTime() >= (operator.gte as Date).getTime();
      }

      return false;
    }

    if (actual instanceof Decimal && expected instanceof Decimal) {
      return actual.equals(expected);
    }

    return actual === expected;
  });
}

function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  orderBy: unknown,
): T[] {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];

  return [...rows].sort((left, right) => {
    for (const clause of clauses as Record<string, "asc" | "desc">[]) {
      for (const [key, direction] of Object.entries(clause)) {
        const leftValue = left[key];
        const rightValue = right[key];
        let comparison = 0;

        if (leftValue instanceof Date && rightValue instanceof Date) {
          comparison = leftValue.getTime() - rightValue.getTime();
        } else if (typeof leftValue === "string" && typeof rightValue === "string") {
          comparison = leftValue.localeCompare(rightValue);
        } else if (typeof leftValue === "number" && typeof rightValue === "number") {
          comparison = leftValue - rightValue;
        }

        if (comparison !== 0) {
          return direction === "desc" ? -comparison : comparison;
        }
      }
    }

    return 0;
  });
}

function applyData<T extends Record<string, unknown>>(row: T, data: Record<string, unknown>): T {
  const updated = { ...row, updatedAt: LATER } as T;

  for (const [key, value] of Object.entries(data)) {
    if (key === "amount") {
      (updated as Record<string, unknown>)[key] = new Decimal(String(value));
    } else {
      (updated as Record<string, unknown>)[key] = value;
    }
  }

  return updated;
}

const prisma = {
  costEntry: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = makeEntryRow({
        ...(data as Partial<EntryRow>),
        id: `entry-${++entrySequence}`,
        amount: new Decimal(String(data.amount)),
        createdAt: NOW,
        updatedAt: NOW,
      });
      entries.set(row.id, row);
      return row;
    }),
    findFirst: vi.fn(
      async ({ where }: { where?: Record<string, unknown> } = {}) =>
        [...entries.values()].find((row) => matchesWhere(row as Record<string, unknown>, where)) ?? null,
    ),
    findMany: vi.fn(
      async ({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      } = {}) => {
        const rows = sortRows(
          [...entries.values()].filter((row) =>
            matchesWhere(row as Record<string, unknown>, where),
          ) as Record<string, unknown>[],
          orderBy,
        ) as unknown as EntryRow[];

        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;

        for (const [id, row] of entries) {
          if (matchesWhere(row as Record<string, unknown>, where)) {
            entries.set(id, applyData(row, data));
            count += 1;
          }
        }

        return { count };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;

      for (const [id, row] of entries) {
        if (matchesWhere(row as Record<string, unknown>, where)) {
          entries.delete(id);
          count += 1;
        }
      }

      return { count };
    }),
  },
  costAllocation: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = makeAllocationRow({
        ...(data as Partial<AllocationRow>),
        id: `allocation-${++allocationSequence}`,
        amount: new Decimal(String(data.amount)),
        createdAt: NOW,
        updatedAt: NOW,
      });
      allocations.set(row.id, row);
      return row;
    }),
    findFirst: vi.fn(
      async ({ where }: { where?: Record<string, unknown> } = {}) =>
        [...allocations.values()].find((row) =>
          matchesWhere(row as Record<string, unknown>, where),
        ) ?? null,
    ),
    findMany: vi.fn(
      async ({
        where,
        orderBy,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      } = {}) => {
        const rows = sortRows(
          [...allocations.values()].filter((row) =>
            matchesWhere(row as Record<string, unknown>, where),
          ) as Record<string, unknown>[],
          orderBy,
        ) as unknown as AllocationRow[];

        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;

        for (const [id, row] of allocations) {
          if (matchesWhere(row as Record<string, unknown>, where)) {
            allocations.set(id, applyData(row, data));
            count += 1;
          }
        }

        return { count };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;

      for (const [id, row] of allocations) {
        if (matchesWhere(row as Record<string, unknown>, where)) {
          allocations.delete(id);
          count += 1;
        }
      }

      return { count };
    }),
  },
  $queryRaw: vi.fn(async () => [{ id: "locked" }]),
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const {
  createCostAllocation,
  createCostEntry,
  deleteCostAllocation,
  deleteCostEntry,
  finalizeCostEntry,
  findCostEntry,
  getCostEntryLedger,
  listCostAllocations,
  listCostEntries,
  updateCostAllocation,
  updateCostEntry,
} = await import("./repository");

function entryInput(overrides: Partial<CostEntryInput> = {}): CostEntryInput {
  return {
    amount: "100.00",
    currency: "EUR",
    actuality: "observed",
    source: {
      kind: "manual",
      enteredBy: "owner-1",
      capturedAt: "2026-03-01T00:00:00.000Z",
    },
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    notes: null,
    dimensions: { projectId: "project-1" },
    ...overrides,
  } as CostEntryInput;
}

beforeEach(() => {
  entries = new Map();
  allocations = new Map();
  entrySequence = 0;
  allocationSequence = 0;
  vi.clearAllMocks();
});

describe("cost entries", () => {
  it("creates a draft entry in the workspace and reads it back", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    expect(entry.status).toBe("DRAFT");
    expect(entry.amount.amount.toFixed(2)).toBe("100.00");
    expect(entry.amount.currency).toBe("EUR");
    expect(entry.periodStart).toBe("2026-03-01");
    expect(entry.periodEnd).toBe("2026-03-31");
    expect(entry.dimensions.projectId).toBe("project-1");
    expect(entry.source).toMatchObject({ kind: "manual", enteredBy: "owner-1" });

    expect(await findCostEntry("ws-1", entry.id)).toMatchObject({ id: entry.id });
    expect(await findCostEntry("ws-2", entry.id)).toBeNull();
  });

  it("round-trips provider and import source references", async () => {
    const provider = await createCostEntry(
      "ws-1",
      entryInput({
        source: {
          kind: "provider",
          provider: "openai",
          externalId: "invoice-1",
          capturedAt: "2026-03-01T00:00:00.000Z",
        },
      }),
    );
    const imported = await createCostEntry(
      "ws-1",
      entryInput({
        source: {
          kind: "import",
          importId: "csv-1",
          rowNumber: 2,
          capturedAt: "2026-03-01T00:00:00.000Z",
        },
      }),
    );

    expect(provider.source).toMatchObject({
      kind: "provider",
      provider: "openai",
      externalId: "invoice-1",
      capturedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(imported.source).toMatchObject({
      kind: "import",
      importId: "csv-1",
      rowNumber: 2,
      capturedAt: "2026-03-01T00:00:00.000Z",
    });

    expect((await findCostEntry("ws-1", provider.id))?.source).toMatchObject({
      kind: "provider",
    });
    expect((await findCostEntry("ws-1", imported.id))?.source).toMatchObject({
      kind: "import",
    });
  });

  it("filters by workspace, status and period overlap", async () => {
    const march = await createCostEntry("ws-1", entryInput());
    const april = await createCostEntry(
      "ws-1",
      entryInput({ periodStart: "2026-04-01", periodEnd: "2026-04-30" }),
    );
    await createCostEntry("ws-2", entryInput());

    expect((await listCostEntries("ws-1")).map((entry) => entry.id)).toEqual([
      april.id,
      march.id,
    ]);
    expect(
      (await listCostEntries("ws-1", { from: "2026-03-15", to: "2026-03-20" })).map(
        (entry) => entry.id,
      ),
    ).toEqual([march.id]);
    expect(await listCostEntries("ws-1", { status: "FINALIZED" })).toEqual([]);
    expect(await listCostEntries("ws-3")).toEqual([]);
  });

  it("updates a draft but refuses a finalized entry", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    expect(
      await updateCostEntry("ws-1", entry.id, entryInput({ amount: "80.00" })),
    ).toBe(true);
    expect((await findCostEntry("ws-1", entry.id))?.amount.amount.toFixed(2)).toBe(
      "80.00",
    );

    await finalizeCostEntry("ws-1", entry.id);

    await expect(
      updateCostEntry("ws-1", entry.id, entryInput({ amount: "70.00" })),
    ).rejects.toBeInstanceOf(FinalizedCostEntryError);
    await expect(deleteCostEntry("ws-1", entry.id)).rejects.toBeInstanceOf(
      FinalizedCostEntryError,
    );
  });

  it("refuses to relabel the currency of an entry that already has allocations", async () => {
    const entry = await createCostEntry("ws-1", entryInput());
    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "10.00",
      dimensions: { projectId: "project-a" },
    });

    await expect(
      updateCostEntry("ws-1", entry.id, entryInput({ currency: "USD" })),
    ).rejects.toBeInstanceOf(InvalidCostEntryError);

    const unchanged = await findCostEntry("ws-1", entry.id);
    expect(unchanged?.amount.currency).toBe("EUR");
    expect(unchanged?.amount.amount.toFixed(2)).toBe("100.00");
  });

  it("refuses to shrink a draft below its allocated total", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "80.00",
      dimensions: { projectId: "project-a" },
    });

    await expect(
      updateCostEntry("ws-1", entry.id, entryInput({ amount: "79.99" })),
    ).rejects.toBeInstanceOf(InvalidAllocationMathError);
    expect((await findCostEntry("ws-1", entry.id))?.amount.amount.toFixed(2)).toBe(
      "100.00",
    );

    expect(
      await updateCostEntry("ws-1", entry.id, entryInput({ amount: "80.00" })),
    ).toBe(true);
  });

  it("refuses a foreign entry without revealing it", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    expect(await updateCostEntry("ws-2", entry.id, entryInput())).toBe(false);
    expect(await deleteCostEntry("ws-2", entry.id)).toBe(false);
    expect(await finalizeCostEntry("ws-2", entry.id)).toBe(false);
  });
});

describe("allocations", () => {
  it("keeps allocated plus unallocated equal to the entry total, in cents", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "33.33",
      dimensions: { projectId: "project-a" },
    });
    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "33.33",
      dimensions: { clientId: "client-b" },
    });
    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "33.34",
      dimensions: { tags: ["shared"] },
    });

    const ledger = await getCostEntryLedger("ws-1", entry.id);

    expect(ledger?.totals.total.amount.toFixed(2)).toBe("100.00");
    expect(ledger?.totals.allocated.amount.toFixed(2)).toBe("100.00");
    expect(ledger?.totals.unallocated.amount.toFixed(2)).toBe("0.00");
    expect(
      assertAllocationConservation(
        BigInt("10000"),
        BigInt("10000"),
      ).unallocatedCents,
    ).toBe(BigInt(0));
  });

  it("refuses an allocation that would exceed the entry by one cent", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "99.99",
      dimensions: { projectId: "project-a" },
    });

    await expect(
      createCostAllocation("ws-1", {
        entryId: entry.id,
        amount: "0.02",
        dimensions: { projectId: "project-b" },
      }),
    ).rejects.toBeInstanceOf(InvalidAllocationMathError);
  });

  it("refuses a foreign entry id and a foreign allocation id", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    await expect(
      createCostAllocation("ws-2", {
        entryId: entry.id,
        amount: "10.00",
        dimensions: { projectId: "project-a" },
      }),
    ).rejects.toBeInstanceOf(CostEntryNotFoundError);
    expect(await listCostAllocations("ws-2", entry.id)).toBeNull();
    expect(await getCostEntryLedger("ws-2", entry.id)).toBeNull();
    expect(
      await updateCostAllocation("ws-2", "unknown", {
        amount: "10.00",
        dimensions: { projectId: "project-a" },
      }),
    ).toBe(false);
    expect(await deleteCostAllocation("ws-2", "unknown")).toBe(false);
  });

  it("updates and deletes an allocation while the entry is a draft", async () => {
    const entry = await createCostEntry("ws-1", entryInput());
    const allocation = await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "30.00",
      dimensions: { projectId: "project-a" },
    });

    expect(
      await updateCostAllocation("ws-1", allocation.id, {
        amount: "45.00",
        dimensions: { projectId: "project-b" },
      }),
    ).toBe(true);
    expect(
      (await listCostAllocations("ws-1", entry.id))?.[0].amount.amount.toFixed(2),
    ).toBe("45.00");

    expect(await deleteCostAllocation("ws-1", allocation.id)).toBe(true);
    expect(await deleteCostAllocation("ws-1", allocation.id)).toBe(false);
    expect(await listCostAllocations("ws-1", entry.id)).toEqual([]);
  });

  it("refuses an update that would push the allocations over the total", async () => {
    const entry = await createCostEntry("ws-1", entryInput());
    const first = await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "30.00",
      dimensions: { projectId: "project-a" },
    });
    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "30.00",
      dimensions: { projectId: "project-b" },
    });

    await expect(
      updateCostAllocation("ws-1", first.id, {
        amount: "80.00",
        dimensions: { projectId: "project-a" },
      }),
    ).rejects.toBeInstanceOf(InvalidAllocationMathError);

    expect(
      (await listCostAllocations("ws-1", entry.id))?.[0].amount.amount.toFixed(2),
    ).toBe("30.00");
  });

  it("keeps the sign of a credit", async () => {
    const entry = await createCostEntry("ws-1", entryInput({ amount: "-100.00" }));

    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "-40.00",
      dimensions: { projectId: "project-a" },
    });

    const ledger = await getCostEntryLedger("ws-1", entry.id);
    expect(ledger?.totals.allocated.amount.toFixed(2)).toBe("-40.00");
    expect(ledger?.totals.unallocated.amount.toFixed(2)).toBe("-60.00");

    await expect(
      createCostAllocation("ws-1", {
        entryId: entry.id,
        amount: "10.00",
        dimensions: { projectId: "project-b" },
      }),
    ).rejects.toBeInstanceOf(InvalidAllocationMathError);
  });
});

describe("finalization", () => {
  it("locks the entry and its allocations, even with an unallocated remainder", async () => {
    const entry = await createCostEntry("ws-1", entryInput());
    const allocation = await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "40.00",
      dimensions: { projectId: "project-a" },
    });

    expect(await finalizeCostEntry("ws-1", entry.id)).toBe(true);
    expect((await findCostEntry("ws-1", entry.id))?.status).toBe("FINALIZED");

    const ledger = await getCostEntryLedger("ws-1", entry.id);
    expect(ledger?.totals.unallocated.amount.toFixed(2)).toBe("60.00");

    await expect(
      createCostAllocation("ws-1", {
        entryId: entry.id,
        amount: "60.00",
        dimensions: { projectId: "project-b" },
      }),
    ).rejects.toBeInstanceOf(FinalizedCostEntryError);
    await expect(
      updateCostAllocation("ws-1", allocation.id, {
        amount: "30.00",
        dimensions: { projectId: "project-a" },
      }),
    ).rejects.toBeInstanceOf(FinalizedCostEntryError);
    await expect(deleteCostAllocation("ws-1", allocation.id)).rejects.toBeInstanceOf(
      FinalizedCostEntryError,
    );
  });

  it("finalizes a fully allocated entry with no remainder", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    await createCostAllocation("ws-1", {
      entryId: entry.id,
      amount: "100.00",
      dimensions: { projectId: "project-a" },
    });

    expect(await finalizeCostEntry("ws-1", entry.id)).toBe(true);
    const ledger = await getCostEntryLedger("ws-1", entry.id);
    expect(ledger?.totals.allocated.amount.toFixed(2)).toBe("100.00");
    expect(ledger?.totals.unallocated.amount.toFixed(2)).toBe("0.00");
  });

  it("is idempotent and keeps the first finalization instant", async () => {
    const entry = await createCostEntry("ws-1", entryInput());

    expect(await finalizeCostEntry("ws-1", entry.id)).toBe(true);
    const first = await findCostEntry("ws-1", entry.id);
    expect(await finalizeCostEntry("ws-1", entry.id)).toBe(true);
    const second = await findCostEntry("ws-1", entry.id);

    expect(second?.finalizedAt?.getTime()).toBe(first?.finalizedAt?.getTime());
  });

  it("allows a correction as a new entry", async () => {
    const entry = await createCostEntry("ws-1", entryInput());
    await finalizeCostEntry("ws-1", entry.id);

    const correction = await createCostEntry(
      "ws-1",
      entryInput({ amount: "12.00", notes: "Correction fictive" }),
    );

    expect(correction.status).toBe("DRAFT");
    expect(correction.id).not.toBe(entry.id);
    expect((await listCostEntries("ws-1"))).toHaveLength(2);
  });

  it("checks conservation before locking the entry", async () => {
    const entry = makeEntryRow({ amount: new Decimal("100.00") });
    entries.set(entry.id, entry);
    allocations.set(
      "allocation-over",
      makeAllocationRow({
        id: "allocation-over",
        entryId: entry.id,
        amount: new Decimal("100.01"),
      }),
    );

    await expect(finalizeCostEntry("ws-1", entry.id)).rejects.toBeInstanceOf(
      InvalidAllocationMathError,
    );
    expect((await findCostEntry("ws-1", entry.id))?.status).toBe("DRAFT");
  });
});
