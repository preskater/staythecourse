import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinalizedCostEntryError } from "./ledger";
import { InvalidAllocationPolicyError } from "./policy";

type Row = Record<string, unknown>;

let policies: Row[] = [];
let versions: Row[] = [];
let entries: Row[] = [];
let allocations: Row[] = [];
let documents: Row[] = [];
let sequence = 0;

const NOW = new Date("2026-03-15T12:00:00.000Z");

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];

    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const operator = expected as Row;
      if ("in" in operator) return (operator.in as unknown[]).includes(actual);
      if ("gte" in operator) {
        return (actual as Date) >= (operator.gte as Date) && (actual as Date) <= (operator.lte as Date);
      }
      return false;
    }

    return actual === expected;
  });
}

function withVersions(policy: Row): Row {
  const latest = versions
    .filter((version) => version.policyId === policy.id)
    .sort((left, right) => (right.version as number) - (left.version as number))
    .slice(0, 1);
  return { ...policy, versions: latest };
}

const prisma = {
  allocationPolicy: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (policies.some((row) => row.workspaceId === data.workspaceId && row.name === data.name)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const id = `policy-${++sequence}`;
      const { versions: nested, ...rest } = data as Row & { versions: { create: Row } };
      policies.push({ ...rest, id, archivedAt: null, createdAt: NOW });
      versions.push({ ...nested.create, id: `version-${++sequence}`, policyId: id, createdAt: NOW });
      return withVersions(policies[policies.length - 1]);
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const row = policies.find((policy) => matches(policy, where));
      return row ? withVersions(row) : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      policies.filter((policy) => matches(policy, where)).map(withVersions),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = policies.filter((policy) => matches(policy, where));
      hits.forEach((policy) => Object.assign(policy, data));
      return { count: hits.length };
    }),
  },
  allocationPolicyVersion: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { ...data, id: `version-${++sequence}`, createdAt: NOW };
      versions.push(row);
      return row;
    }),
  },
  costEntry: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => entries.find((row) => matches(row, where)) ?? null),
  },
  costAllocation: {
    findMany: vi.fn(async ({ where }: { where: Row }) => allocations.filter((row) => matches(row, where))),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      allocations.push(...data.map((row) => ({ ...row, id: `allocation-${++sequence}` })));
      return { count: data.length };
    }),
  },
  revenueDocument: {
    findMany: vi.fn(async ({ where }: { where: Row }) => documents.filter((row) => matches(row, where))),
  },
  $queryRaw: vi.fn(async () => []),
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));

const {
  AllocationPolicyNotFoundError,
  applyAllocationPolicy,
  archiveAllocationPolicy,
  createAllocationPolicy,
  listAllocationPolicies,
  reviseAllocationPolicy,
} = await import("./policy.repository");

function addEntry(overrides: Row = {}): string {
  const id = `entry-${++sequence}`;
  entries.push({
    id,
    workspaceId: "ws-1",
    amount: new Decimal("100.00"),
    currency: "EUR",
    status: "DRAFT",
    periodStart: new Date("2026-03-01T00:00:00.000Z"),
    periodEnd: new Date("2026-03-31T00:00:00.000Z"),
    ...overrides,
  });
  return id;
}

const seatPolicy = {
  name: "Sièges Cursor",
  kind: "EQUAL_SEAT",
  rationale: "Chaque siège coûte pareil.",
  targets: [{ dimensions: { projectId: "p-a" } }, { dimensions: { projectId: "p-b" } }],
};

beforeEach(() => {
  policies = [];
  versions = [];
  entries = [];
  allocations = [];
  documents = [];
  sequence = 0;
  vi.clearAllMocks();
});

describe("policy versions", () => {
  it("creates version 1 and refuses a duplicate name in the workspace", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    expect(policy.latestVersion.version).toBe(1);
    expect(policy.latestVersion.rationale).toBe("Chaque siège coûte pareil.");
    await expect(createAllocationPolicy("ws-1", seatPolicy)).rejects.toThrow(/already used/);
  });

  it("a revision adds a version and keeps the previous one", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    const revised = await reviseAllocationPolicy("ws-1", policy.id, {
      rationale: "Ajout du projet C.",
      targets: [...seatPolicy.targets, { dimensions: { projectId: "p-c" } }],
    });

    expect(revised.latestVersion.version).toBe(2);
    expect(revised.latestVersion.targets).toHaveLength(3);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
  });

  it("does not reach a policy of another workspace", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    await expect(
      reviseAllocationPolicy("ws-2", policy.id, { rationale: "x", targets: seatPolicy.targets }),
    ).rejects.toBeInstanceOf(AllocationPolicyNotFoundError);
    expect(await archiveAllocationPolicy("ws-2", policy.id)).toBe(false);
  });
});

describe("applyAllocationPolicy", () => {
  it("records the policy version and the measure on every allocation", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    const entryId = addEntry();

    const applied = await applyAllocationPolicy("ws-1", {
      entryId,
      policyId: policy.id,
      measures: ["2", "1"],
    });

    expect(applied).toMatchObject({ version: 1, created: 2 });
    expect(allocations).toEqual([
      expect.objectContaining({ amount: "66.67", projectId: "p-a", policyVersionId: applied.policyVersionId, policyMeasure: "2" }),
      expect.objectContaining({ amount: "33.33", projectId: "p-b", policyVersionId: applied.policyVersionId, policyMeasure: "1" }),
    ]);
  });

  it("a dry run returns the plan and writes nothing", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    const entryId = addEntry();

    const preview = await applyAllocationPolicy("ws-1", { entryId, policyId: policy.id, measures: ["2", "1"], dryRun: true });

    expect(preview.created).toBe(0);
    expect(preview.planned.map((row) => [row.dimensions.projectId, row.amount, row.measure])).toEqual([
      ["p-a", "66.67", "2"],
      ["p-b", "33.33", "1"],
    ]);
    expect(allocations).toHaveLength(0);
    expect(prisma.costAllocation.createMany).not.toHaveBeenCalled();
  });

  it("splits only the unallocated remainder and keeps existing allocations", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    const entryId = addEntry();
    allocations.push({ id: "manual", entryId, amount: new Decimal("40.00"), policyVersionId: null });

    await applyAllocationPolicy("ws-1", { entryId, policyId: policy.id, measures: ["1", "1"] });

    expect(allocations.map((row) => String(row.amount))).toEqual(["40", "30.00", "30.00"]);
    await expect(
      applyAllocationPolicy("ws-1", { entryId, policyId: policy.id, measures: ["1", "1"] }),
    ).rejects.toThrow(/nothing left/);
  });

  it("never touches a finalized entry", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    const entryId = addEntry({ status: "FINALIZED" });

    await expect(
      applyAllocationPolicy("ws-1", { entryId, policyId: policy.id, measures: ["1", "1"] }),
    ).rejects.toBeInstanceOf(FinalizedCostEntryError);
    expect(prisma.costAllocation.createMany).not.toHaveBeenCalled();
  });

  it("an archived policy keeps its allocations but cannot be applied or revised", async () => {
    const policy = await createAllocationPolicy("ws-1", seatPolicy);
    const entryId = addEntry();
    await applyAllocationPolicy("ws-1", { entryId, policyId: policy.id, measures: ["1", "1"] });

    expect(await archiveAllocationPolicy("ws-1", policy.id, NOW)).toBe(true);
    expect(await archiveAllocationPolicy("ws-1", policy.id)).toBe(true);
    expect(policies[0].archivedAt).toEqual(NOW);
    expect(allocations).toHaveLength(2);
    expect(versions).toHaveLength(1);
    expect(await listAllocationPolicies("ws-1")).toEqual([]);
    expect(await listAllocationPolicies("ws-1", { includeArchived: true })).toHaveLength(1);

    await expect(
      applyAllocationPolicy("ws-1", { entryId: addEntry(), policyId: policy.id, measures: ["1", "1"] }),
    ).rejects.toBeInstanceOf(InvalidAllocationPolicyError);
    await expect(
      reviseAllocationPolicy("ws-1", policy.id, { rationale: "x", targets: seatPolicy.targets }),
    ).rejects.toThrow(/archived/);
  });

  it("revenue weighting reads the period's net invoiced revenue", async () => {
    const policy = await createAllocationPolicy("ws-1", {
      ...seatPolicy,
      name: "Au prorata du CA",
      kind: "REVENUE_WEIGHTED",
    });
    const entryId = addEntry();
    documents.push(
      { workspaceId: "ws-1", projectId: "p-a", kind: "INVOICE", currency: "EUR", amount: new Decimal("3000"), issuedOn: new Date("2026-03-10T00:00:00.000Z") },
      { workspaceId: "ws-1", projectId: "p-b", kind: "INVOICE", currency: "EUR", amount: new Decimal("1000"), issuedOn: new Date("2026-03-20T00:00:00.000Z") },
      { workspaceId: "ws-1", projectId: "p-b", kind: "INVOICE", currency: "EUR", amount: new Decimal("9000"), issuedOn: new Date("2026-04-02T00:00:00.000Z") },
    );

    await applyAllocationPolicy("ws-1", { entryId, policyId: policy.id });

    expect(allocations.map((row) => [row.projectId, row.amount, row.policyMeasure])).toEqual([
      ["p-a", "75.00", "3000"],
      ["p-b", "25.00", "1000"],
    ]);
  });
});
