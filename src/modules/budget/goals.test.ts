import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  computeGoalProgress,
  goalInputSchema,
  goalUpdateSchema,
  summariseGoalTotals,
  type GoalRecord,
} from "./goals";

/** Fictitious values only. Dates are calendar days at UTC midnight, like the app. */

const NOW = new Date(Date.UTC(2026, 9, 6)); // 2026-10-06

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "goal-1",
    name: "Apport immobilier",
    targetAmount: new Decimal("1000"),
    currency: "EUR",
    // 2027-06 − 2026-10 = 8 whole calendar months.
    targetDate: new Date(Date.UTC(2027, 5, 30)),
    status: "ACTIVE",
    currentAmount: null,
    accountId: null,
    accountName: null,
    ...overrides,
  };
}

describe("computeGoalProgress", () => {
  it("reads a partial goal as an amount, a percentage and a monthly contribution", () => {
    const progress = computeGoalProgress(goal({ currentAmount: new Decimal("300") }), null, {
      now: NOW,
    });

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.current.toFixed(2)).toBe("300.00");
    expect(progress.remaining.toFixed(2)).toBe("700.00");
    expect(progress.percentage.toFixed(1)).toBe("30.0");
    expect(progress.reached).toBe(false);
    expect(progress.monthsLeft).toBe(8);
    // 700 ÷ 8 = 87.50, exact.
    expect(progress.monthlyContribution?.toFixed(2)).toBe("87.50");
    expect(progress.contributionNote).toBeNull();
  });

  it("reads a complete goal as reached, with nothing left to plan", () => {
    const progress = computeGoalProgress(goal({ currentAmount: new Decimal("1000") }), null, {
      now: NOW,
    });

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.remaining.toFixed(2)).toBe("0.00");
    expect(progress.percentage.toFixed(1)).toBe("100.0");
    expect(progress.reached).toBe(true);
    expect(progress.monthlyContribution).toBeNull();
    expect(progress.contributionNote).toMatch(/Objectif atteint/);
  });

  it("keeps an over-target goal visible, percentage above one hundred", () => {
    const progress = computeGoalProgress(goal({ currentAmount: new Decimal("1200") }), null, {
      now: NOW,
    });

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.percentage.toFixed(1)).toBe("120.0");
    expect(progress.remaining.toFixed(2)).toBe("-200.00");
    expect(progress.reached).toBe(true);
    expect(progress.monthlyContribution).toBeNull();
  });

  it("does not define a monthly contribution once the target date has passed", () => {
    const progress = computeGoalProgress(
      goal({ currentAmount: new Decimal("300"), targetDate: new Date(Date.UTC(2026, 8, 30)) }),
      null,
      { now: NOW },
    );

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.monthsLeft).toBe(0);
    expect(progress.monthlyContribution).toBeNull();
    expect(progress.contributionNote).toMatch(/Échéance passée/);
  });

  it("asks the whole remaining amount when the deadline falls this month", () => {
    const progress = computeGoalProgress(
      goal({ currentAmount: new Decimal("300"), targetDate: new Date(Date.UTC(2026, 9, 31)) }),
      null,
      { now: NOW },
    );

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    // Zero months remaining: no division, the rest is due this month.
    expect(progress.monthsLeft).toBe(0);
    expect(progress.monthlyContribution?.toFixed(2)).toBe("700.00");
    expect(progress.contributionNote).toBeNull();
  });

  it("reads a missing source as unknown, never as zero", () => {
    const noSource = computeGoalProgress(goal(), null, { now: NOW });

    expect(noSource.kind).toBe("UNKNOWN");
    if (noSource.kind !== "UNKNOWN") {
      return;
    }
    // The message must say it is unknown — and that it is not zero.
    expect(noSource.reason).toMatch(/inconnue, pas zéro/);

    const emptyAccount = computeGoalProgress(goal({ accountId: "account-1" }), null, {
      now: NOW,
    });

    expect(emptyAccount.kind).toBe("UNKNOWN");
    if (emptyAccount.kind !== "UNKNOWN") {
      return;
    }
    expect(emptyAccount.reason).toMatch(/compte lié/);
  });

  it("reads a linked account's recorded balance as the current amount", () => {
    const progress = computeGoalProgress(goal({ accountId: "account-1" }), new Decimal("250"), {
      now: NOW,
    });

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.current.toFixed(2)).toBe("250.00");
    expect(progress.percentage.toFixed(1)).toBe("25.0");
  });

  it("reads a negative account balance as 0 % but keeps the real amounts", () => {
    const progress = computeGoalProgress(goal({ accountId: "account-1" }), new Decimal("-500"), {
      now: NOW,
    });

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.current.toFixed(2)).toBe("-500.00");
    expect(progress.percentage.toFixed(1)).toBe("0.0");
    expect(progress.remaining.toFixed(2)).toBe("1500.00");
    expect(progress.reached).toBe(false);
  });

  it("rounds the monthly contribution half-up on cents", () => {
    // 100.01 ÷ 2 = 50.005 → 50.01.
    const progress = computeGoalProgress(
      goal({
        targetAmount: new Decimal("100.01"),
        currentAmount: new Decimal("0"),
        targetDate: new Date(Date.UTC(2026, 11, 31)),
      }),
      null,
      { now: NOW },
    );

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.monthsLeft).toBe(2);
    expect(progress.monthlyContribution?.toFixed(2)).toBe("50.01");
  });

  it("rounds the percentage half-up to one decimal", () => {
    // 1 ÷ 3 = 33.333… % → 33.3 %.
    const progress = computeGoalProgress(
      goal({ targetAmount: new Decimal("3"), currentAmount: new Decimal("1") }),
      null,
      { now: NOW },
    );

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.percentage.toFixed(1)).toBe("33.3");
  });
});

describe("goalInputSchema", () => {
  const valid = {
    name: "Apport immobilier",
    targetAmount: "1 000",
    currency: "EUR",
    targetDate: "2027-06-30",
    status: "ACTIVE",
    currentAmount: "",
    accountId: "",
  };

  it("accepts a manual-amount goal and normalises the empty fields", () => {
    const parsed = goalInputSchema.safeParse({ ...valid, currentAmount: "300" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.targetAmount.toFixed(2)).toBe("1000.00");
      expect(parsed.data.currentAmount?.toFixed(2)).toBe("300.00");
      expect(parsed.data.accountId).toBeNull();
    }
  });

  it("accepts a goal with neither source: progress will read as unknown", () => {
    const parsed = goalInputSchema.safeParse(valid);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currentAmount).toBeNull();
      expect(parsed.data.accountId).toBeNull();
    }
  });

  it("refuses a manual amount and a linked account at the same time", () => {
    const parsed = goalInputSchema.safeParse({
      ...valid,
      currentAmount: "300",
      accountId: "account-1",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /pas les deux/.test(issue.message))).toBe(true);
    }
  });

  it("refuses a negative current amount", () => {
    const parsed = goalInputSchema.safeParse({ ...valid, currentAmount: "-10" });

    expect(parsed.success).toBe(false);
  });

  it("refuses a target amount that is not strictly positive", () => {
    expect(goalInputSchema.safeParse({ ...valid, targetAmount: "0" }).success).toBe(false);
    expect(goalInputSchema.safeParse({ ...valid, targetAmount: "-5" }).success).toBe(false);
  });

  it("refuses an impossible calendar day", () => {
    expect(goalInputSchema.safeParse({ ...valid, targetDate: "2027-02-31" }).success).toBe(false);
  });

  it("carries the same rules on the update contract", () => {
    const parsed = goalUpdateSchema.safeParse({ ...valid, id: "goal-1", currentAmount: "-1" });

    expect(parsed.success).toBe(false);
    // Without an identifier, an update is not an update.
    expect(goalUpdateSchema.safeParse({ ...valid, id: "  " }).success).toBe(false);
  });
});

describe("computeGoalProgress with contributions", () => {
  it("adds the contributions to the manual starting amount", () => {
    const progress = computeGoalProgress(goal({ currentAmount: new Decimal("300") }), null, {
      now: NOW,
      contributionSum: new Decimal("150"),
    });

    expect(progress.kind).toBe("KNOWN");
    if (progress.kind !== "KNOWN") {
      return;
    }

    expect(progress.current.toFixed(2)).toBe("450.00");
    expect(progress.remaining.toFixed(2)).toBe("550.00");
    expect(progress.percentage.toFixed(1)).toBe("45.0");
  });

  it("reads the contributions alone when the goal has no starting amount", () => {
    const progress = computeGoalProgress(goal(), null, {
      now: NOW,
      contributionSum: new Decimal("200"),
    });

    expect(progress.kind).toBe("KNOWN");
    expect(progress.kind === "KNOWN" && progress.current.toFixed(2)).toBe("200.00");
  });

  it("stays unknown without any amount and without contributions", () => {
    const progress = computeGoalProgress(goal(), null, { now: NOW, contributionSum: null });

    expect(progress.kind).toBe("UNKNOWN");
  });

  it("ignores contributions on an account-linked goal: the balance is the single source", () => {
    const progress = computeGoalProgress(
      goal({ accountId: "account-1" }),
      new Decimal("800"),
      { now: NOW, contributionSum: new Decimal("150") },
    );

    expect(progress.kind).toBe("KNOWN");
    expect(progress.kind === "KNOWN" && progress.current.toFixed(2)).toBe("800.00");
  });
});

describe("summariseGoalTotals", () => {
  function rows(...items: { goal: GoalRecord; progress: ReturnType<typeof computeGoalProgress> }[]) {
    return items;
  }

  function known(partial: Partial<GoalRecord>, current: string) {
    return {
      goal: goal(partial),
      progress: computeGoalProgress(goal({ ...partial, currentAmount: new Decimal(current) }), null, {
        now: NOW,
      }),
    };
  }

  it("returns nothing for an empty list, rather than a zero row", () => {
    expect(summariseGoalTotals([]).size).toBe(0);
  });

  it("weights the global percentage by the target amounts, not by the goal count", () => {
    const totals = summariseGoalTotals(
      rows(
        known({ id: "small", name: "Petit", targetAmount: new Decimal("100") }, "100"),
        known({ id: "big", name: "Grand", targetAmount: new Decimal("900") }, "0"),
      ),
    );

    const eur = totals.get("EUR");
    expect(eur?.goalCount).toBe(2);
    expect(eur?.target.toFixed(2)).toBe("1000.00");
    expect(eur?.current.toFixed(2)).toBe("100.00");
    // 100 / 1000, not the mean of 100 % and 0 %.
    expect(eur?.percentage?.toFixed(1)).toBe("10.0");
    expect(eur?.remaining.toFixed(2)).toBe("900.00");
  });

  it("keeps currencies apart and totals each column of one currency", () => {
    const totals = summariseGoalTotals(
      rows(
        known({ id: "a", targetAmount: new Decimal("500") }, "250"),
        known({ id: "b", targetAmount: new Decimal("1000"), currency: "USD" }, "1000"),
      ),
    );

    expect(totals.size).toBe(2);
    expect(totals.get("EUR")?.percentage?.toFixed(1)).toBe("50.0");
    expect(totals.get("USD")?.percentage?.toFixed(1)).toBe("100.0");
    expect(totals.get("USD")?.remaining.toFixed(2)).toBe("0.00");
  });

  it("shows no global percentage when one goal's progress is unknown", () => {
    const totals = summariseGoalTotals(
      rows(
        known({ id: "a", targetAmount: new Decimal("1000") }, "400"),
        {
          goal: goal({ id: "b", targetAmount: new Decimal("500") }),
          progress: computeGoalProgress(goal({ id: "b" }), null, { now: NOW }),
        },
      ),
    );

    const eur = totals.get("EUR");
    expect(eur?.complete).toBe(false);
    expect(eur?.percentage).toBeNull();
    expect(eur?.monthlyContribution).toBeNull();
    // The known row is still summed, and the caller renders "—" for it.
    expect(eur?.current.toFixed(2)).toBe("400.00");
  });

  it("counts a reached goal as zero monthly contribution and ignores a passed deadline", () => {
    const totals = summariseGoalTotals(
      rows(
        // Reached: 1 000 / 1 000, nothing left to plan.
        known({ id: "a", targetAmount: new Decimal("1000") }, "1200"),
        // Open: 400 remaining over 8 whole months → 50.00 a month.
        known({ id: "b", targetAmount: new Decimal("400") }, "0"),
      ),
    );

    const eur = totals.get("EUR");
    expect(eur?.monthlyContribution?.toFixed(2)).toBe("50.00");
    expect(eur?.percentage?.toFixed(1)).toBe("85.7");
  });

  it("reports the earliest deadline of the group", () => {
    const totals = summariseGoalTotals(
      rows(
        known({ id: "a", targetDate: new Date(Date.UTC(2028, 0, 31)) }, "100"),
        known({ id: "b", targetDate: new Date(Date.UTC(2027, 2, 15)) }, "100"),
      ),
    );

    expect(totals.get("EUR")?.nextDeadline.toISOString().slice(0, 10)).toBe("2027-03-15");
  });

  /** A goal whose current amount is the recorded balance of one linked account. */
  function linked(partial: Partial<GoalRecord>, accountId: string, balance: string) {
    const record = goal({ accountId, accountName: accountId, ...partial });
    return {
      goal: record,
      progress: computeGoalProgress(record, new Decimal(balance), { now: NOW }),
    };
  }

  it("counts an account shared by several goals once, but every target in full", () => {
    const eur = summariseGoalTotals(
      rows(
        linked({ id: "a", targetAmount: new Decimal("400") }, "account-1", "350"),
        linked({ id: "b", targetAmount: new Decimal("800") }, "account-1", "350"),
      ),
    ).get("EUR");

    // 400 + 800 of targets, 350 € set aside once — not 700 €.
    expect(eur?.goalCount).toBe(2);
    expect(eur?.target.toFixed(2)).toBe("1200.00");
    expect(eur?.current.toFixed(2)).toBe("350.00");
    expect(eur?.remaining.toFixed(2)).toBe("850.00");
    expect(eur?.percentage?.toFixed(1)).toBe("29.2");
    expect(eur?.sharedAccount).toBe(true);
    // Each row still states its own monthly ask: 50 ÷ 8 + 450 ÷ 8.
    expect(eur?.monthlyContribution?.toFixed(2)).toBe("62.50");
  });

  it("counts goals on two different accounts in full", () => {
    const eur = summariseGoalTotals(
      rows(
        linked({ id: "a", targetAmount: new Decimal("400") }, "account-1", "350"),
        linked({ id: "b", targetAmount: new Decimal("800") }, "account-2", "350"),
        known({ id: "c", targetAmount: new Decimal("100") }, "10"),
      ),
    ).get("EUR");

    expect(eur?.current.toFixed(2)).toBe("710.00");
    expect(eur?.remaining.toFixed(2)).toBe("590.00");
    expect(eur?.sharedAccount).toBe(false);
  });

  it("never deduplicates two manual amounts: they are two separate sums set aside", () => {
    const eur = summariseGoalTotals(
      rows(
        known({ id: "a", targetAmount: new Decimal("400") }, "100"),
        known({ id: "b", targetAmount: new Decimal("800") }, "100"),
      ),
    ).get("EUR");

    expect(eur?.current.toFixed(2)).toBe("200.00");
    expect(eur?.sharedAccount).toBe(false);
  });
});
