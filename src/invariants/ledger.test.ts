import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  allocateCents,
  assertAllocationConservation,
  toCents,
} from "@/modules/ai-costs/allocation";
import type { TransactionRecord, TransactionType } from "@/modules/budget/domain";
import { computeMonthlyTotals } from "@/modules/budget/totals";
import {
  cashflowInputSchema,
  computePropertyTotals,
  resolveCashflowAmount,
  UnresolvedCashflowError,
  type CashflowEntry,
} from "@/modules/real-estate/domain";
import { randomInt, seededRandom } from "./helpers";

const CASES = 300;

function cents(random: () => number, min: number, max: number): Decimal {
  return new Decimal(randomInt(random, min, max)).dividedBy(100);
}

function transaction(type: TransactionType, amount: Decimal, id: string): TransactionRecord {
  const day = new Date("2026-03-10T00:00:00.000Z");
  return {
    id,
    type,
    amount,
    currency: "EUR",
    operationDate: day,
    label: `Fictif ${id}`,
    accountId: "account-fixture",
    accountName: null,
    categoryId: null,
    categoryName: null,
    notes: null,
    externalRef: null,
    transferGroupId: type === "TRANSFER" ? "group-fixture" : null,
    reconciledAt: null,
    createdAt: day,
  };
}

/**
 * Invariant 3 — a property cashflow carries an amount **or** a linked transaction,
 * never both and never neither. That exclusivity is what keeps a linked transaction
 * from being counted twice in a property's totals.
 */
describe("invariant: cashflow amount XOR linked transaction", () => {
  const base = { propertyId: "property-fixture", kind: "EXPENSE", label: "Taxe fictive" } as const;

  it("accepts exactly one of the two", () => {
    expect(cashflowInputSchema.safeParse({ ...base, amount: "120,00" }).success).toBe(true);
    expect(cashflowInputSchema.safeParse({ ...base, transactionId: "transaction-fixture" }).success).toBe(true);
  });

  it("refuses both, and refuses neither", () => {
    expect(
      cashflowInputSchema.safeParse({ ...base, amount: "120,00", transactionId: "transaction-fixture" }).success,
    ).toBe(false);
    expect(cashflowInputSchema.safeParse({ ...base }).success).toBe(false);
  });

  it("a stored entry with neither cannot be totalled silently", () => {
    const orphan: CashflowEntry = {
      id: "cashflow-orphan",
      kind: "EXPENSE",
      label: "Orpheline",
      currency: "EUR",
      amount: null,
      dueDate: null,
      settledAt: null,
      transaction: null,
    };
    expect(() => resolveCashflowAmount(orphan)).toThrow(UnresolvedCashflowError);
  });

  it("each entry counts exactly once, linked or standalone", () => {
    const random = seededRandom(42);

    for (let run = 0; run < CASES; run += 1) {
      let expectedIncome = new Decimal(0);
      let expectedExpenses = new Decimal(0);
      const entries: CashflowEntry[] = Array.from({ length: randomInt(random, 0, 20) }, (_, index) => {
        const kind = random() < 0.5 ? "INCOME" : "EXPENSE";
        const magnitude = cents(random, 1, 500_000);
        const signed = kind === "INCOME" ? magnitude : magnitude.negated();
        const linked = random() < 0.5;

        if (kind === "INCOME") expectedIncome = expectedIncome.plus(magnitude);
        else expectedExpenses = expectedExpenses.plus(magnitude);

        return {
          id: `cashflow-${index}`,
          kind,
          label: `Flux ${index}`,
          currency: "EUR",
          amount: linked ? null : signed,
          dueDate: null,
          settledAt: null,
          transaction: linked ? { id: `transaction-${index}`, label: `Op ${index}`, amount: signed } : null,
        };
      });

      const totals = computePropertyTotals(entries, { currency: "EUR" });
      expect(totals.income.equals(expectedIncome), `run ${run}`).toBe(true);
      expect(totals.expenses.equals(expectedExpenses), `run ${run}`).toBe(true);
      expect(totals.net.equals(expectedIncome.minus(expectedExpenses))).toBe(true);
    }
  });

  it("negative control: counting the linked transaction on top of the entry doubles it", () => {
    const amount = new Decimal("-80.00");
    const linked: CashflowEntry = {
      id: "cashflow-linked",
      kind: "EXPENSE",
      label: "Assurance fictive",
      currency: "EUR",
      amount: null,
      dueDate: null,
      settledAt: null,
      transaction: { id: "transaction-linked", label: "Assurance", amount },
    };
    const naiveDoubleCount = resolveCashflowAmount(linked).plus(linked.transaction!.amount).abs();

    expect(computePropertyTotals([linked]).expenses.equals(amount.abs())).toBe(true);
    expect(naiveDoubleCount.equals(amount.abs())).toBe(false);
  });
});

/**
 * Invariant 4 — transfers count by their sign, and `transfers` is a subset of the
 * income and expense figures, never an extra amount (see `budget/totals.ts`).
 */
describe("invariant: transfer inclusion in monthly totals", () => {
  it("a linked pair of legs leaves the net unchanged and is counted once per side", () => {
    const random = seededRandom(5);

    for (let run = 0; run < CASES; run += 1) {
      const others = Array.from({ length: randomInt(random, 0, 15) }, (_, index) =>
        transaction(
          random() < 0.5 ? "INCOME" : "EXPENSE",
          cents(random, -100_000, 100_000),
          `other-${index}`,
        ),
      );
      const leg = cents(random, 1, 500_000);
      const before = computeMonthlyTotals(others, { currency: "EUR" });
      const after = computeMonthlyTotals(
        [...others, transaction("TRANSFER", leg.negated(), "out"), transaction("TRANSFER", leg, "in")],
        { currency: "EUR" },
      );

      expect(after.net.equals(before.net), `run ${run}`).toBe(true);
      expect(after.income.minus(before.income).equals(leg)).toBe(true);
      expect(after.expenses.minus(before.expenses).equals(leg)).toBe(true);
      expect(after.transfers.equals(leg.times(2))).toBe(true);
    }
  });

  it("the transfer volume is the sum of what transfers added to both sides", () => {
    const random = seededRandom(6);

    for (let run = 0; run < CASES; run += 1) {
      const rows = Array.from({ length: randomInt(random, 0, 25) }, (_, index) =>
        transaction(
          (["INCOME", "EXPENSE", "TRANSFER"] as const)[randomInt(random, 0, 2)],
          cents(random, -200_000, 200_000),
          `row-${index}`,
        ),
      );
      const withoutTransfers = computeMonthlyTotals(
        rows.filter((row) => row.type !== "TRANSFER"),
        { currency: "EUR" },
      );
      const totals = computeMonthlyTotals(rows, { currency: "EUR" });
      const addedBySides = totals.income
        .minus(withoutTransfers.income)
        .plus(totals.expenses.minus(withoutTransfers.expenses));

      expect(totals.transfers.equals(addedBySides), `run ${run}`).toBe(true);
      expect(totals.net.equals(totals.income.minus(totals.expenses))).toBe(true);
    }
  });

  it("a single outgoing leg (money sent to untracked savings) lowers the balance", () => {
    const totals = computeMonthlyTotals([transaction("TRANSFER", new Decimal("-300.00"), "single")]);
    expect(totals.net.equals(new Decimal("-300.00"))).toBe(true);
  });

  it("negative control: adding the volume on top of the sides would double-count", () => {
    const rows = [transaction("TRANSFER", new Decimal("-50.00"), "out"), transaction("TRANSFER", new Decimal("50.00"), "in")];
    const totals = computeMonthlyTotals(rows);
    const doubleCounted = totals.income.plus(totals.transfers);

    expect(doubleCounted.equals(totals.income)).toBe(false);
    expect(totals.net.isZero()).toBe(true);
  });
});

/**
 * Invariant 7 — cost allocations conserve every cent.
 *
 * A weighted split never rounds the total: the leftover cents go to the largest
 * remainders, and the derived unallocated remainder always closes the identity
 * `allocated + unallocated === total`. The sign of a credit is preserved.
 */
describe("invariant: cost allocation conservation", () => {
  it("splits every cent with the entry's sign, across random weights", () => {
    const random = seededRandom(2_026);
    const ZERO = BigInt(0);

    for (let run = 0; run < CASES; run += 1) {
      const total = cents(random, -500_000, 500_000);
      const parts = randomInt(random, 1, 10);
      const weights = Array.from({ length: parts }, () =>
        BigInt(randomInt(random, 0, 10)),
      );

      if (weights.every((weight) => weight === ZERO)) {
        weights[0] = BigInt(1);
      }

      const totalCents = toCents(total);
      const shares = allocateCents(totalCents, weights);
      const allocated = shares.reduce((sum, share) => sum + share, ZERO);
      const summary = assertAllocationConservation(totalCents, allocated);

      expect(allocated, `run ${run}`).toBe(totalCents);
      expect(
        summary.allocatedCents + summary.unallocatedCents,
        `run ${run}`,
      ).toBe(summary.totalCents);

      for (const share of shares) {
        expect(
          share === ZERO || (share < ZERO) === total.isNegative(),
          `run ${run}`,
        ).toBe(true);
      }
    }
  });
});
