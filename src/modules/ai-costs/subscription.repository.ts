import Decimal from "decimal.js";
import { isUniqueConstraintError } from "@/lib/actions";
import { getPrisma } from "@/lib/db";
import { toDateOnlyString } from "@/lib/dates";
import { assertCurrency } from "@/lib/money";
import type { RecurrenceFrequency } from "@/modules/budget/recurrence";
import { validateCostEntryInput } from "./ledger";
import { applyAllocationPolicy, findAllocationPolicy } from "./policy.repository";
import { entryData } from "./repository";
import {
  currentPeriod,
  dueRenewals,
  MAX_SUBSCRIPTIONS,
  periodCost,
  renewalPeriod,
  SUBSCRIPTION_POLICY_KINDS,
  SUBSCRIPTION_TAG,
  subscriptionPolicyMeasures,
  type AiSubscription,
  type AiSubscriptionInput,
} from "./subscriptions";

/**
 * Subscription register persistence (M12-05).
 *
 * Workspace-scoped like the rest of the ledger; authorization is the caller's job.
 * Subscriptions are never deleted: cancelling stamps `cancelledOn`, and the renewals
 * already booked stay in the ledger as ordinary cost entries.
 */

export class InvalidSubscriptionError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidSubscriptionError";
  }
}

export type AiSubscriptionRecord = AiSubscription & { renewalCount: number };

type SubscriptionRow = {
  id: string;
  provider: string;
  plan: string;
  seats: number;
  seatPrice: Decimal.Value;
  currency: string;
  frequency: string;
  startDate: Date;
  cancelledOn: Date | null;
  allowance: Decimal.Value | null;
  ownerId: string | null;
  allocationPolicyId: string | null;
  createdBy: string;
  notes: string | null;
};

function toSubscription(row: SubscriptionRow): AiSubscription {
  return {
    ...row,
    seatPrice: new Decimal(row.seatPrice.toString()),
    currency: assertCurrency(row.currency),
    frequency: row.frequency as RecurrenceFrequency,
    allowance: row.allowance === null ? null : new Decimal(row.allowance.toString()),
  };
}

export async function listAiSubscriptions(workspaceId: string): Promise<AiSubscriptionRecord[]> {
  const rows = await getPrisma().aiSubscription.findMany({
    where: { workspaceId },
    orderBy: [{ cancelledOn: { sort: "asc", nulls: "first" } }, { provider: "asc" }, { plan: "asc" }],
    take: MAX_SUBSCRIPTIONS,
    include: { _count: { select: { renewals: true } } },
  });

  return rows.map((row) => ({
    ...toSubscription(row as unknown as SubscriptionRow),
    renewalCount: row._count.renewals,
  }));
}

/** A policy is usable when it is in this workspace, active and of a kind a renewal can apply. */
async function assertUsablePolicy(workspaceId: string, policyId: string): Promise<void> {
  const policy = await findAllocationPolicy(workspaceId, policyId);
  if (!policy || policy.archivedAt) {
    throw new InvalidSubscriptionError("allocationPolicyId", "Politique d'allocation introuvable ou archivée.");
  }
  if (!SUBSCRIPTION_POLICY_KINDS.includes(policy.kind)) {
    throw new InvalidSubscriptionError(
      "allocationPolicyId",
      "Cette politique demande des mesures saisies à chaque fois : choisissez une répartition par siège, par pourcentage ou par revenu.",
    );
  }
}

export async function createAiSubscription(
  workspaceId: string,
  createdBy: string,
  input: AiSubscriptionInput,
): Promise<{ id: string }> {
  if (input.allocationPolicyId) await assertUsablePolicy(workspaceId, input.allocationPolicyId);

  const prisma = getPrisma();
  if ((await prisma.aiSubscription.count({ where: { workspaceId } })) >= MAX_SUBSCRIPTIONS) {
    throw new InvalidSubscriptionError("provider", "Nombre maximal d'abonnements atteint.");
  }

  return prisma.aiSubscription.create({
    data: {
      workspaceId,
      createdBy,
      provider: input.provider,
      plan: input.plan,
      seats: input.seats,
      seatPrice: input.seatPrice.toFixed(2),
      currency: input.currency,
      frequency: input.frequency,
      startDate: input.startDate,
      allowance: input.allowance?.toFixed(2) ?? null,
      ownerId: input.ownerId,
      allocationPolicyId: input.allocationPolicyId,
      notes: input.notes,
    },
    select: { id: true },
  });
}

/**
 * Stops renewals from `cancelledOn` on. `false` when the subscription is not in this
 * workspace or is already cancelled; a cancellation never precedes the start date.
 */
export async function cancelAiSubscription(
  workspaceId: string,
  subscriptionId: string,
  cancelledOn: Date,
): Promise<boolean> {
  const prisma = getPrisma();
  const found = await prisma.aiSubscription.findFirst({
    where: { id: subscriptionId, workspaceId, cancelledOn: null },
    select: { startDate: true },
  });
  if (!found) return false;
  if (cancelledOn < found.startDate) {
    throw new InvalidSubscriptionError("cancelledOn", "La résiliation ne peut pas précéder le début.");
  }

  const { count } = await prisma.aiSubscription.updateMany({
    where: { id: subscriptionId, workspaceId, cancelledOn: null },
    data: { cancelledOn },
  });
  return count === 1;
}

/**
 * Books every due renewal not booked yet: one DERIVED cost entry each, then the
 * subscription's allocation policy, if any. Re-runnable: the unique
 * (subscriptionId, renewalDate) pair turns a replay or a concurrent pass into a no-op.
 *
 * A policy that cannot split the amount (no revenue in the period, for example) leaves
 * the entry unallocated rather than failing the booking: the remainder shows in the
 * ledger as unallocated, which is the truth.
 */
export async function bookDueRenewals(workspaceId: string, today: Date): Promise<number> {
  const prisma = getPrisma();
  const subscriptions = await listAiSubscriptions(workspaceId);
  let booked = 0;

  for (const subscription of subscriptions) {
    const due = dueRenewals(subscription, today);
    if (due.length === 0) continue;

    const existing = await prisma.aiSubscriptionRenewal.findMany({
      where: { subscriptionId: subscription.id, subscription: { workspaceId } },
      select: { renewalDate: true },
    });
    const done = new Set(existing.map((row) => toDateOnlyString(row.renewalDate)));

    for (const renewalDate of due.filter((date) => !done.has(toDateOnlyString(date)))) {
      const entryId = await bookRenewal(workspaceId, subscription, renewalDate);
      if (entryId === null) continue;
      booked += 1;

      if (subscription.allocationPolicyId) {
        await allocateRenewal(workspaceId, subscription.allocationPolicyId, entryId);
      }
    }
  }

  return booked;
}

async function bookRenewal(
  workspaceId: string,
  subscription: AiSubscription,
  renewalDate: Date,
): Promise<string | null> {
  const period = renewalPeriod(subscription, renewalDate);
  const validated = validateCostEntryInput({
    amount: periodCost(subscription),
    currency: subscription.currency,
    actuality: "derived",
    source: { kind: "manual", enteredBy: subscription.createdBy },
    periodStart: period.start,
    periodEnd: period.end,
    notes: `Abonnement ${subscription.provider} — ${subscription.plan} (${subscription.seats} siège(s))`,
    dimensions: { developerId: subscription.ownerId, tags: [SUBSCRIPTION_TAG] },
  });

  try {
    return await getPrisma().$transaction(async (tx) => {
      const entry = await tx.costEntry.create({
        data: { workspaceId, ...entryData(validated) },
        select: { id: true },
      });
      await tx.aiSubscriptionRenewal.create({
        data: { subscriptionId: subscription.id, renewalDate, costEntryId: entry.id },
      });
      return entry.id;
    });
  } catch (error) {
    // Another pass booked this renewal first: the transaction rolled the entry back.
    if (isUniqueConstraintError(error)) return null;
    throw error;
  }
}

async function allocateRenewal(workspaceId: string, policyId: string, entryId: string): Promise<void> {
  try {
    const policy = await findAllocationPolicy(workspaceId, policyId);
    if (!policy || policy.archivedAt || !SUBSCRIPTION_POLICY_KINDS.includes(policy.kind)) return;

    await applyAllocationPolicy(workspaceId, {
      entryId,
      policyId,
      measures: subscriptionPolicyMeasures(policy.kind, policy.latestVersion.targets.length),
    });
  } catch (error) {
    console.error(`[ai-subscriptions] allocation skipped: ${error instanceof Error ? error.name : typeof error}`);
  }
}

/**
 * Metered spend of each subscription's provider over its current period, for the
 * allowance: entries of that provider and currency, without the subscription tag.
 * `null` when no such entry exists (no data, never "nothing used").
 */
export async function readSubscriptionMetered(
  workspaceId: string,
  subscriptions: readonly AiSubscription[],
  today: Date,
): Promise<Map<string, Decimal | null>> {
  const prisma = getPrisma();
  const result = new Map<string, Decimal | null>();

  await Promise.all(
    subscriptions.map(async (subscription) => {
      const period = currentPeriod(subscription, today);
      if (subscription.allowance === null || period === null) return;

      const aggregate = await prisma.costEntry.aggregate({
        where: {
          workspaceId,
          sourceProvider: subscription.provider,
          currency: subscription.currency,
          periodStart: { gte: period.start, lte: period.end },
          NOT: { tags: { has: SUBSCRIPTION_TAG } },
        },
        _sum: { amount: true },
        _count: { _all: true },
      });
      result.set(
        subscription.id,
        aggregate._count._all === 0 ? null : new Decimal((aggregate._sum.amount ?? 0).toString()),
      );
    }),
  );

  return result;
}

export type CoreFormulaRow = { currency: string; metered: Decimal; subscriptions: Decimal; entryCount: number };

/**
 * The core formula over `[start, end)`, per currency: metered usage (entries without
 * the subscription tag) plus subscriptions (tagged entries). Same entries as the
 * overview's spend, so the total reconciles with it.
 */
export async function readCoreFormula(
  workspaceId: string,
  start: Date,
  end: Date,
): Promise<CoreFormulaRow[]> {
  const prisma = getPrisma();
  const where = { workspaceId, periodStart: { gte: start, lt: end } };
  const [subscriptions, metered] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["currency"],
      where: { ...where, tags: { has: SUBSCRIPTION_TAG } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.costEntry.groupBy({
      by: ["currency"],
      where: { ...where, NOT: { tags: { has: SUBSCRIPTION_TAG } } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const rows = new Map<string, CoreFormulaRow>();
  const row = (currency: string) =>
    rows.get(currency) ??
    rows
      .set(currency, { currency, metered: new Decimal(0), subscriptions: new Decimal(0), entryCount: 0 })
      .get(currency)!;

  for (const group of metered) {
    const target = row(group.currency);
    target.metered = new Decimal((group._sum.amount ?? 0).toString());
    target.entryCount += group._count._all;
  }
  for (const group of subscriptions) {
    const target = row(group.currency);
    target.subscriptions = new Decimal((group._sum.amount ?? 0).toString());
    target.entryCount += group._count._all;
  }

  return [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
