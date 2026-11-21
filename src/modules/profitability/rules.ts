import type Decimal from "decimal.js";
import { allocateCents, fromCents, toCents } from "@/modules/ai-costs/allocation";

/**
 * Project profitability (M15-01): one pure, deterministic calculation, used by every
 * view. No I/O, no clock: the same inputs and rule version give the same outputs.
 *
 * Every result carries the rule version that produced it. A rule change is a new
 * version added to `PROFITABILITY_RULE_VERSIONS`, never an edit of an existing one, so
 * a figure computed yesterday stays explainable.
 *
 * Rules v1, per currency, never converted, over an inclusive day range:
 *
 * - **Recognised revenue**: an invoice counts on its issue day for its amount, unless it
 *   carries a recognition snapshot (M10-02), which then counts instead (its day, its
 *   amount). A credit note subtracts its amount on its own issue day. Payments, refunds
 *   and write-offs are cash events: they never change recognised revenue.
 * - **Direct cost**: ledger entries whose period starts in the range. An entry with
 *   allocations counts through them, each on its own project; the unallocated remainder
 *   goes to the entry's own project. Each cent lands once: never double counted.
 * - **Overhead**: what lands on no project. It is spread over the projects with
 *   positive recognised revenue in that currency, in proportion to it (largest
 *   remainder, whole cents). With no such project it stays unallocated.
 * - **Contribution margin** = revenue − direct cost; **project result** = contribution
 *   margin − allocated overhead.
 *
 * Conservation, per currency: direct costs + allocated overhead + unallocated overhead
 * = every cost of the range.
 */

export const PROFITABILITY_RULE_VERSIONS = ["v1"] as const;
export type ProfitabilityRuleVersion = (typeof PROFITABILITY_RULE_VERSIONS)[number];
export const CURRENT_PROFITABILITY_RULE_VERSION: ProfitabilityRuleVersion = "v1";

/** The rule text shown next to a figure, per version. */
export const PROFITABILITY_RULE_DESCRIPTIONS: Record<ProfitabilityRuleVersion, Record<string, string>> = {
  v1: {
    revenue: "Factures à leur date d'émission (ou instantané de reconnaissance), moins les avoirs à leur date.",
    directCost: "Coûts du registre attribués au projet : répartitions d'abord, reste non réparti au projet de l'entrée.",
    overhead: "Coûts sans projet, répartis au prorata du revenu reconnu des projets.",
    contributionMargin: "Revenu reconnu − coût direct.",
    result: "Marge sur coûts directs − frais généraux répartis.",
  },
};

export class UnknownProfitabilityRuleVersionError extends Error {
  constructor(version: string) {
    super(`Unknown profitability rule version: ${version}`);
    this.name = "UnknownProfitabilityRuleVersionError";
  }
}

export type RevenueDocumentInput = {
  projectId: string;
  currency: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  /** Positive magnitude. */
  amount: Decimal;
  issuedOn: Date;
  recognizedOn: Date | null;
  recognizedAmount: Decimal | null;
};

export type CostEntryInput = {
  /** Signed: a negative amount is a credit or a refund. */
  amount: Decimal;
  currency: string;
  periodStart: Date;
  projectId: string | null;
  allocations: readonly { amount: Decimal; projectId: string | null }[];
};

export type ProfitabilityInputs = {
  projects: readonly { id: string; name: string }[];
  revenueDocuments: readonly RevenueDocumentInput[];
  costEntries: readonly CostEntryInput[];
};

export type ProjectProfitability = {
  projectId: string;
  /** `null` when the ledger names a project the register does not know. */
  projectName: string | null;
  currency: string;
  revenue: Decimal;
  directCost: Decimal;
  contributionMargin: Decimal;
  overhead: Decimal;
  result: Decimal;
};

export type CurrencyProfitability = {
  currency: string;
  revenue: Decimal;
  totalCost: Decimal;
  directCost: Decimal;
  overheadAllocated: Decimal;
  overheadUnallocated: Decimal;
};

export type ProfitabilityResult = {
  ruleVersion: ProfitabilityRuleVersion;
  period: { from: Date; to: Date };
  projects: ProjectProfitability[];
  currencies: CurrencyProfitability[];
};

type Bucket = { revenue: bigint; directCost: bigint; overhead: bigint };

function inRange(day: Date, from: Date, to: Date): boolean {
  return day >= from && day <= to;
}

/** Revenue events v1: one signed amount in cents and a day per document. */
function recognised(document: RevenueDocumentInput): { day: Date; cents: bigint } {
  if (document.kind === "CREDIT_NOTE") {
    return { day: document.issuedOn, cents: -toCents(document.amount) };
  }
  return document.recognizedOn !== null && document.recognizedAmount !== null
    ? { day: document.recognizedOn, cents: toCents(document.recognizedAmount) }
    : { day: document.issuedOn, cents: toCents(document.amount) };
}

/** Where each cent of an entry lands: `[projectId | null, cents]`, summing to the entry. */
function attribute(entry: CostEntryInput): [string | null, bigint][] {
  const total = toCents(entry.amount);
  const parts = entry.allocations.map((allocation): [string | null, bigint] => [
    allocation.projectId,
    toCents(allocation.amount),
  ]);
  const remainder = total - parts.reduce((sum, [, cents]) => sum + cents, BigInt(0));
  return remainder === BigInt(0) && parts.length > 0 ? parts : [...parts, [entry.projectId, remainder]];
}

export function calculateProfitability(
  inputs: ProfitabilityInputs,
  period: { from: Date; to: Date },
  version: string = CURRENT_PROFITABILITY_RULE_VERSION,
): ProfitabilityResult {
  if (!(PROFITABILITY_RULE_VERSIONS as readonly string[]).includes(version)) {
    throw new UnknownProfitabilityRuleVersionError(version);
  }

  const buckets = new Map<string, Bucket>();
  const overheadByCurrency = new Map<string, bigint>();
  const totalCostByCurrency = new Map<string, bigint>();
  const bucket = (projectId: string, currency: string) => {
    const key = `${currency}\u0000${projectId}`;
    if (!buckets.has(key)) buckets.set(key, { revenue: BigInt(0), directCost: BigInt(0), overhead: BigInt(0) });
    return buckets.get(key)!;
  };
  const add = (map: Map<string, bigint>, key: string, cents: bigint) => map.set(key, (map.get(key) ?? BigInt(0)) + cents);

  for (const document of inputs.revenueDocuments) {
    const { day, cents } = recognised(document);
    if (inRange(day, period.from, period.to)) bucket(document.projectId, document.currency).revenue += cents;
  }

  for (const entry of inputs.costEntries) {
    if (!inRange(entry.periodStart, period.from, period.to)) continue;
    add(totalCostByCurrency, entry.currency, toCents(entry.amount));
    for (const [projectId, cents] of attribute(entry)) {
      if (projectId === null) add(overheadByCurrency, entry.currency, cents);
      else bucket(projectId, entry.currency).directCost += cents;
    }
  }

  // Overhead follows revenue: projects with positive revenue share it, per currency.
  const unallocatedByCurrency = new Map<string, bigint>();
  for (const [currency, overhead] of overheadByCurrency) {
    const earners = [...buckets.entries()].filter(
      ([key, value]) => key.startsWith(`${currency}\u0000`) && value.revenue > BigInt(0),
    );
    if (overhead === BigInt(0)) continue;
    if (earners.length === 0) {
      unallocatedByCurrency.set(currency, overhead);
      continue;
    }
    const shares = allocateCents(overhead, earners.map(([, value]) => value.revenue));
    earners.forEach(([, value], index) => (value.overhead += shares[index]));
  }

  const names = new Map(inputs.projects.map((project) => [project.id, project.name]));
  const projects = [...buckets.entries()]
    .map(([key, value]) => {
      const [currency, projectId] = key.split("\u0000");
      const margin = value.revenue - value.directCost;
      return {
        projectId,
        projectName: names.get(projectId) ?? null,
        currency,
        revenue: fromCents(value.revenue),
        directCost: fromCents(value.directCost),
        contributionMargin: fromCents(margin),
        overhead: fromCents(value.overhead),
        result: fromCents(margin - value.overhead),
      };
    })
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        (a.projectName ?? a.projectId).localeCompare(b.projectName ?? b.projectId) ||
        a.projectId.localeCompare(b.projectId),
    );

  const currencies = [...new Set([...buckets.keys()].map((key) => key.split("\u0000")[0]).concat([...totalCostByCurrency.keys()]))]
    .sort()
    .map((currency) => {
      const ofCurrency = [...buckets.entries()].filter(([key]) => key.startsWith(`${currency}\u0000`)).map(([, value]) => value);
      const sum = (pick: (value: Bucket) => bigint) => ofCurrency.reduce((total, value) => total + pick(value), BigInt(0));
      return {
        currency,
        revenue: fromCents(sum((value) => value.revenue)),
        totalCost: fromCents(totalCostByCurrency.get(currency) ?? BigInt(0)),
        directCost: fromCents(sum((value) => value.directCost)),
        overheadAllocated: fromCents(sum((value) => value.overhead)),
        overheadUnallocated: fromCents(unallocatedByCurrency.get(currency) ?? BigInt(0)),
      };
    });

  return {
    ruleVersion: version as ProfitabilityRuleVersion,
    period: { from: period.from, to: period.to },
    projects,
    currencies,
  };
}
