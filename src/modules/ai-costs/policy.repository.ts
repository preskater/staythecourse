import Decimal from "decimal.js";
import type { Prisma } from "@/generated/prisma/client";
import { isUniqueConstraintError } from "@/lib/actions";
import { getPrisma } from "@/lib/db";
import { toDateOnlyString } from "@/lib/dates";
import { toCents, fromCents } from "./allocation";
import { toCostDimensionColumns } from "./dimensions";
import { assertCostEntryEditable, CostEntryNotFoundError } from "./ledger";
import {
  InvalidAllocationPolicyError,
  planPolicyAllocations,
  revenueMeasures,
  validatePolicyKind,
  validatePolicyName,
  validatePolicyRationale,
  validatePolicyTargets,
  type AllocationPolicyKind,
  type PlannedAllocation,
  type PolicyTarget,
} from "./policy";
import { findEntryMoney, lockEntry, toStatus } from "./repository";

/**
 * Allocation policy persistence (M9-03).
 *
 * Versions are insert-only: a revision adds `version + 1`, nothing updates or deletes
 * a version, and archiving only stamps `archivedAt`. Every allocation a policy creates
 * stores its version and the measure it read, so a split stays explainable after the
 * policy changes or is archived.
 *
 * Authorization is the caller's job, like the rest of the ledger: these functions are
 * workspace-scoped and must only be reached after a server-side permission check.
 */

export class AllocationPolicyNotFoundError extends Error {
  constructor() {
    super("Allocation policy not found in this workspace.");
    this.name = "AllocationPolicyNotFoundError";
  }
}

export type AllocationPolicyVersion = {
  readonly id: string;
  readonly version: number;
  readonly rationale: string;
  readonly targets: readonly PolicyTarget[];
  readonly createdAt: Date;
};

export type AllocationPolicy = {
  readonly id: string;
  readonly name: string;
  readonly kind: AllocationPolicyKind;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly latestVersion: AllocationPolicyVersion;
};

export type AllocationPolicyInput = {
  name: string;
  kind: AllocationPolicyKind | string;
  rationale: string;
  targets: unknown;
};

export type AllocationPolicyRevisionInput = {
  rationale: string;
  targets: unknown;
};

export type ApplyAllocationPolicyInput = {
  entryId: string;
  policyId: string;
  /** One per target, in target order. Omitted for fixed-percentage and revenue-weighted. */
  measures?: readonly Decimal.Value[] | null;
  /** Plan only: nothing is written (the inbox preview, M9-06). */
  dryRun?: boolean;
};

export type PlannedAllocationRow = {
  readonly dimensions: PlannedAllocation["dimensions"];
  /** Exact signed amount, two decimals. */
  readonly amount: string;
  readonly measure: string;
};

export type AppliedAllocationPolicy = {
  readonly policyVersionId: string;
  readonly version: number;
  readonly created: number;
  readonly planned: readonly PlannedAllocationRow[];
};

type VersionRow = {
  id: string;
  version: number;
  rationale: string;
  targets: unknown;
  createdAt: Date;
};

type PolicyRow = {
  id: string;
  name: string;
  kind: string;
  archivedAt: Date | null;
  createdAt: Date;
  versions: VersionRow[];
};

const LATEST_VERSION = {
  orderBy: { version: "desc" as const },
  take: 1,
  select: { id: true, version: true, rationale: true, targets: true, createdAt: true },
};

const POLICY_SELECT = {
  id: true,
  name: true,
  kind: true,
  archivedAt: true,
  createdAt: true,
  versions: LATEST_VERSION,
} as const;

function toPolicy(row: PolicyRow): AllocationPolicy {
  const kind = validatePolicyKind(row.kind);
  const latest = row.versions[0];

  if (!latest) {
    throw new Error("Stored allocation policy has no version.");
  }

  return {
    id: row.id,
    name: row.name,
    kind,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    latestVersion: {
      id: latest.id,
      version: latest.version,
      rationale: latest.rationale,
      targets: validatePolicyTargets(kind, latest.targets),
      createdAt: latest.createdAt,
    },
  };
}

function storedTargets(targets: readonly PolicyTarget[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(targets)) as Prisma.InputJsonValue;
}

export async function listAllocationPolicies(
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
): Promise<AllocationPolicy[]> {
  const rows = (await getPrisma().allocationPolicy.findMany({
    where: { workspaceId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: POLICY_SELECT,
  })) as PolicyRow[];

  return rows.map(toPolicy);
}

export async function findAllocationPolicy(
  workspaceId: string,
  policyId: string,
): Promise<AllocationPolicy | null> {
  const row = (await getPrisma().allocationPolicy.findFirst({
    where: { id: policyId, workspaceId },
    select: POLICY_SELECT,
  })) as PolicyRow | null;

  return row ? toPolicy(row) : null;
}

/** Creates a policy with its first version. A name is unique per workspace. */
export async function createAllocationPolicy(
  workspaceId: string,
  input: AllocationPolicyInput,
): Promise<AllocationPolicy> {
  const name = validatePolicyName(input.name);
  const kind = validatePolicyKind(input.kind);
  const rationale = validatePolicyRationale(input.rationale);
  const targets = validatePolicyTargets(kind, input.targets);

  try {
    const row = (await getPrisma().allocationPolicy.create({
      data: {
        workspaceId,
        name,
        kind,
        versions: { create: { version: 1, rationale, targets: storedTargets(targets) } },
      },
      select: POLICY_SELECT,
    })) as PolicyRow;

    return toPolicy(row);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new InvalidAllocationPolicyError("name", "already used in this workspace");
    }

    throw error;
  }
}

/**
 * Records a new version. Earlier versions and the allocations they produced are left
 * untouched. An archived policy cannot be revised.
 */
export async function reviseAllocationPolicy(
  workspaceId: string,
  policyId: string,
  input: AllocationPolicyRevisionInput,
): Promise<AllocationPolicy> {
  const rationale = validatePolicyRationale(input.rationale);

  return getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AllocationPolicy" WHERE "id" = ${policyId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const current = (await tx.allocationPolicy.findFirst({
      where: { id: policyId, workspaceId },
      select: POLICY_SELECT,
    })) as PolicyRow | null;

    if (!current) {
      throw new AllocationPolicyNotFoundError();
    }

    if (current.archivedAt) {
      throw new InvalidAllocationPolicyError("policy", "an archived policy cannot be revised");
    }

    const kind = validatePolicyKind(current.kind);
    const targets = validatePolicyTargets(kind, input.targets);

    await tx.allocationPolicyVersion.create({
      data: {
        policyId,
        version: (current.versions[0]?.version ?? 0) + 1,
        rationale,
        targets: storedTargets(targets),
      },
    });

    const row = (await tx.allocationPolicy.findFirst({
      where: { id: policyId, workspaceId },
      select: POLICY_SELECT,
    })) as PolicyRow;

    return toPolicy(row);
  });
}

/**
 * Archives a policy: it disappears from new applications, its versions and the
 * allocations they produced stay. Idempotent; `false` means not in this workspace.
 */
export async function archiveAllocationPolicy(
  workspaceId: string,
  policyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const prisma = getPrisma();
  const found = await prisma.allocationPolicy.findFirst({
    where: { id: policyId, workspaceId },
    select: { id: true },
  });

  if (!found) {
    return false;
  }

  await prisma.allocationPolicy.updateMany({
    where: { id: policyId, workspaceId, archivedAt: null },
    data: { archivedAt: now },
  });

  return true;
}

/**
 * Splits a draft entry's unallocated remainder with the policy's latest version.
 *
 * Existing allocations are kept (hand-entered or from an earlier application); a
 * finalized entry refuses the call, so applying a policy never rewrites history.
 * To re-split, delete the draft allocations first.
 */
export async function applyAllocationPolicy(
  workspaceId: string,
  input: ApplyAllocationPolicyInput,
): Promise<AppliedAllocationPolicy> {
  const policy = await findAllocationPolicy(workspaceId, input.policyId);

  if (!policy) {
    throw new AllocationPolicyNotFoundError();
  }

  if (policy.archivedAt) {
    throw new InvalidAllocationPolicyError("policy", "an archived policy cannot be applied");
  }

  return getPrisma().$transaction(async (tx) => {
    const found = await findEntryMoney(tx, workspaceId, input.entryId);

    if (!found) {
      throw new CostEntryNotFoundError();
    }

    assertCostEntryEditable(toStatus(found.status));
    await lockEntry(tx, workspaceId, input.entryId);

    const entry = (await tx.costEntry.findFirst({
      where: { id: input.entryId, workspaceId },
      select: { amount: true, currency: true, status: true, periodStart: true, periodEnd: true },
    })) as {
      amount: Decimal.Value;
      currency: string;
      status: string;
      periodStart: Date;
      periodEnd: Date;
    } | null;

    if (!entry) {
      throw new CostEntryNotFoundError();
    }

    assertCostEntryEditable(toStatus(entry.status));

    const existing = (await tx.costAllocation.findMany({
      where: { entryId: input.entryId },
      select: { amount: true },
    })) as { amount: Decimal.Value }[];
    const remainder =
      toCents(new Decimal(entry.amount.toString())) -
      existing.reduce(
        (sum, row) => sum + toCents(new Decimal(row.amount.toString())),
        BigInt(0),
      );

    const version = policy.latestVersion;
    let measures = input.measures;

    if (policy.kind === "REVENUE_WEIGHTED") {
      if (measures !== null && measures !== undefined) {
        throw new InvalidAllocationPolicyError("measures", "revenue is read from the ledger");
      }

      const periodStart = toDateOnlyString(entry.periodStart);
      const periodEnd = toDateOnlyString(entry.periodEnd);
      const documents = (await tx.revenueDocument.findMany({
        where: {
          workspaceId,
          projectId: {
            in: version.targets.map((target) => target.dimensions.projectId ?? ""),
          },
          issuedOn: { gte: entry.periodStart, lte: entry.periodEnd },
        },
        select: { projectId: true, kind: true, currency: true, amount: true, issuedOn: true },
      })) as {
        projectId: string;
        kind: "INVOICE" | "CREDIT_NOTE";
        currency: string;
        amount: Decimal.Value;
        issuedOn: Date;
      }[];

      measures = revenueMeasures(
        version.targets,
        documents.map((document) => ({
          ...document,
          issuedOn: toDateOnlyString(document.issuedOn),
        })),
        { currency: entry.currency, periodStart, periodEnd },
      );
    }

    const planned = planPolicyAllocations(policy.kind, version.targets, remainder, measures);

    const rows = planned.map((row) => ({
      dimensions: row.dimensions,
      amount: fromCents(row.amountCents).toFixed(2),
      measure: row.measure.toFixed(),
    }));

    if (input.dryRun) {
      return { policyVersionId: version.id, version: version.version, created: 0, planned: rows };
    }

    await tx.costAllocation.createMany({
      data: planned.map((row) => ({
        entryId: input.entryId,
        amount: fromCents(row.amountCents).toFixed(2),
        ...toCostDimensionColumns(row.dimensions),
        policyVersionId: version.id,
        policyMeasure: row.measure.toFixed(),
      })),
    });

    return { policyVersionId: version.id, version: version.version, created: planned.length, planned: rows };
  });
}
