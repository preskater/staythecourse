import { describe, expect, it } from "vitest";
import { resolveBudgetTab } from "./budget-tabs";

describe("resolveBudgetTab", () => {
  it("recognises the loans tab", () => {
    expect(resolveBudgetTab("loans")).toBe("loans");
  });

  it("opens the loans tab from an editLoan link", () => {
    expect(resolveBudgetTab(undefined, { editLoanId: "loan-1" })).toBe("loans");
  });

  it("keeps the existing edit links working", () => {
    expect(resolveBudgetTab(undefined, { editBudgetId: "budget-1" })).toBe("budgets");
    expect(resolveBudgetTab(undefined, { editRecurringId: "recurring-1" })).toBe("forecast");
    expect(resolveBudgetTab(undefined, { editGoalId: "goal-1" })).toBe("goals");
    expect(resolveBudgetTab(undefined)).toBe("operations");
  });
});
