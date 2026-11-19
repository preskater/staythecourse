import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ALERT_RULE_DEFAULTS, describeAlert, type AlertRuleConfig } from "@/modules/alerts/domain";
import { planAlertChanges } from "@/modules/alerts/lifecycle";
import {
  AI_BUDGET_DIMENSIONS,
  aiBudgetInputSchema,
  evaluateAiBudgetOverrun,
  evaluateAiBudgetThreshold,
  toAiBudgetRows,
  type AiBudget,
  type AiBudgetSpend,
} from "./budgets";

const MONTH = "2026-11";
const overrunRule = ALERT_RULE_DEFAULTS.AI_BUDGET_OVERRUN;
const thresholdRule = ALERT_RULE_DEFAULTS.AI_BUDGET_THRESHOLD;

function budget(overrides: Partial<AiBudget> = {}): AiBudget {
  return {
    id: "budget-1",
    dimension: "workspace",
    dimensionValue: "",
    amount: new Decimal("100.00"),
    currency: "EUR",
    ...overrides,
  };
}

const spend = (spent: string, entryCount = 3, budgetId = "budget-1"): AiBudgetSpend => ({
  budgetId,
  spent: new Decimal(spent),
  entryCount,
});

function evaluate(budgets: AiBudget[], spends: AiBudgetSpend[], rules?: { overrun?: AlertRuleConfig; threshold?: AlertRuleConfig }) {
  return [
    ...evaluateAiBudgetOverrun(budgets, spends, rules?.overrun ?? overrunRule, { monthKey: MONTH }),
    ...evaluateAiBudgetThreshold(budgets, spends, rules?.threshold ?? thresholdRule, { monthKey: MONTH }),
  ];
}

describe("AI budget rules, per dimension", () => {
  it.each(AI_BUDGET_DIMENSIONS.map(({ code }) => code))(
    "%s: below the threshold is quiet, at 80 %% warns, past the cap overruns",
    (dimension) => {
      const scoped = budget({ dimension, dimensionValue: dimension === "workspace" ? "" : "value-1" });

      expect(evaluate([scoped], [spend("79.99")])).toEqual([]);

      const [warning] = evaluate([scoped], [spend("80.00")]);
      expect(warning).toMatchObject({
        kind: "AI_BUDGET_THRESHOLD",
        fingerprint: "ai-budget-threshold:budget-1:2026-11",
        inputs: { percent: "80.0", thresholdPercent: "80", planned: "100.00", actual: "80.00" },
      });

      const [overrun] = evaluate([scoped], [spend("100.01")]);
      expect(overrun).toMatchObject({
        kind: "AI_BUDGET_OVERRUN",
        fingerprint: "ai-budget-overrun:budget-1:2026-11",
        inputs: { overrun: "0.01", overrunPercent: "0.0" },
      });
      expect(describeAlert(overrun).reason).toContain(dimension === "workspace" ? "Tout l'espace" : "« value-1 »");
    },
  );
});

describe("AI budget rules, boundaries", () => {
  it("keeps the threshold episode at exactly 100 %, and hands over on the first cent past", () => {
    expect(evaluate([budget()], [spend("100.00")]).map((candidate) => candidate.kind)).toEqual([
      "AI_BUDGET_THRESHOLD",
    ]);
    expect(evaluate([budget()], [spend("100.01")]).map((candidate) => candidate.kind)).toEqual([
      "AI_BUDGET_OVERRUN",
    ]);
  });

  it("applies the overrun margin on the exact percentage", () => {
    const overrun = { ...overrunRule, thresholdPercent: new Decimal(10) };
    expect(evaluate([budget()], [spend("109.99")], { overrun })).toEqual([]);
    expect(evaluate([budget()], [spend("110.00")], { overrun })[0].kind).toBe("AI_BUDGET_OVERRUN");
  });

  it("never warns when refunds exceed the spend", () => {
    const threshold = { ...thresholdRule, thresholdPercent: new Decimal(0) };
    expect(evaluate([budget()], [spend("-5.00")], { threshold })).toEqual([]);
  });

  it("stays silent when the rule is disabled", () => {
    const disabled = {
      overrun: { ...overrunRule, enabled: false },
      threshold: { ...thresholdRule, enabled: false },
    };
    expect(evaluate([budget()], [spend("500.00")], disabled)).toEqual([]);
  });
});

describe("sparse data", () => {
  it("keeps a budget with no entry in scope quiet, even with a zero threshold", () => {
    const threshold = { ...thresholdRule, thresholdPercent: new Decimal(0) };

    expect(evaluate([budget()], [spend("0", 0)], { threshold })).toEqual([]);
    expect(evaluate([budget()], [], { threshold })).toEqual([]);
  });

  it("evaluates each budget on its own spend only", () => {
    const budgets = [budget(), budget({ id: "budget-2", dimension: "provider", dimensionValue: "openai" })];
    const candidates = evaluate(budgets, [spend("150", 2, "budget-2")]);

    expect(candidates.map((candidate) => candidate.fingerprint)).toEqual(["ai-budget-overrun:budget-2:2026-11"]);
  });
});

describe("lifecycle with the existing alert machinery", () => {
  it("is re-runnable without duplicates, resolves on handover and reopens after a resolution", () => {
    const first = evaluate([budget()], [spend("85")]);
    const created = planAlertChanges([], first);
    expect(created.creates).toHaveLength(1);

    const threshold = { id: "alert-1", fingerprint: first[0].fingerprint, status: "ACTIVE" as const };

    // Same data, second pass: refreshed, never duplicated.
    const rerun = planAlertChanges([threshold], evaluate([budget()], [spend("85")]));
    expect(rerun.creates).toEqual([]);
    expect(rerun.refreshes).toHaveLength(1);

    // The overrun takes over: the preventive episode resolves, the overrun one opens.
    const handover = planAlertChanges([threshold], evaluate([budget()], [spend("120")]));
    expect(handover.resolves).toEqual(["alert-1"]);
    expect(handover.creates.map((candidate) => candidate.kind)).toEqual(["AI_BUDGET_OVERRUN"]);

    // A dismissed episode stays silent while the condition holds...
    const dismissed = { ...threshold, status: "DISMISSED" as const };
    const stillDismissed = planAlertChanges([dismissed], evaluate([budget()], [spend("85")]));
    expect(stillDismissed.reopens).toEqual([]);
    // ...and a resolved one reopens when the condition comes back.
    const resolved = { ...threshold, status: "RESOLVED" as const };
    expect(planAlertChanges([resolved], evaluate([budget()], [spend("85")])).reopens).toHaveLength(1);
  });
});

describe("aiBudgetInputSchema", () => {
  const parse = (values: Record<string, string>) =>
    aiBudgetInputSchema.safeParse({ dimension: "workspace", dimensionValue: "", amount: "200,00", currency: "EUR", ...values });

  it("drops the value of a workspace budget and keeps exact amounts", () => {
    const parsed = parse({ dimensionValue: "ignored" });
    expect(parsed.success && parsed.data.dimensionValue).toBe("");
    expect(parsed.success && parsed.data.amount.toFixed(2)).toBe("200.00");
  });

  it("requires a value for a scoped dimension", () => {
    expect(parse({ dimension: "project" }).success).toBe(false);
    expect(parse({ dimension: "project", dimensionValue: "proj-a" }).success).toBe(true);
  });

  it.each(["0", "-1", "1.001", "abc", ""])("refuses the amount %j", (amount) => {
    expect(parse({ amount }).success).toBe(false);
  });

  it("refuses an unknown dimension (no per-model budget) and an unsupported currency", () => {
    expect(parse({ dimension: "model" }).success).toBe(false);
    expect(parse({ currency: "XYZ" }).success).toBe(false);
  });
});

describe("toAiBudgetRows", () => {
  it("shows no data as such, and the state against the configured threshold", () => {
    const budgets = [budget(), budget({ id: "budget-2", currency: "USD" }), budget({ id: "budget-3" })];
    const rows = toAiBudgetRows(budgets, [spend("85"), spend("10", 1, "budget-3")], new Decimal(80));

    expect(rows.map((row) => [row.state, row.percent])).toEqual([
      ["threshold", "85,0 %"],
      ["no-data", null],
      ["ok", "10,0 %"],
    ]);
    expect(rows[0].spent).toContain("85,00");
    expect(rows[1].spent).toBeNull();
    for (const row of rows) {
      expect(Object.values(row).every((value) => value === null || typeof value === "string")).toBe(true);
    }
  });
});
