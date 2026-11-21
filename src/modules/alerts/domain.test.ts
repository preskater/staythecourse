import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  ALERT_KINDS,
  alertRulesInputSchema,
  budgetOverrunFingerprint,
  describeAlert,
  lowBalanceFingerprint,
  overdueEventFingerprint,
  resolveAlertRules,
  staleIntegrationFingerprint,
  toAlertRulesFormValues,
  unusualExpenseFingerprint,
} from "./domain";

describe("fingerprints", () => {
  it("identifies rule + entity + period, with the period bounding monthly rules", () => {
    expect(lowBalanceFingerprint("account-1")).toBe("low-balance:account-1");
    expect(budgetOverrunFingerprint("category-1", "EUR", "2026-10")).toBe(
      "budget-overrun:category-1:EUR:2026-10",
    );
    expect(unusualExpenseFingerprint("tx-1")).toBe("unusual-expense:tx-1");
    expect(staleIntegrationFingerprint("connection-1")).toBe("stale-integration:connection-1");
    expect(overdueEventFingerprint("cashflow-1")).toBe("overdue-event:cashflow-1");
  });

  it("gives the same overrun a new identity every month", () => {
    expect(budgetOverrunFingerprint("c1", "EUR", "2026-10")).not.toBe(
      budgetOverrunFingerprint("c1", "EUR", "2026-11"),
    );
  });
});

describe("describeAlert", () => {
  it("reads a low balance from its stored inputs", () => {
    const described = describeAlert({
      kind: "LOW_BALANCE",
      inputs: {
        accountName: "Compte courant",
        currency: "EUR",
        balance: "42.50",
        threshold: "100.00",
      },
    });

    expect(described.title).toBe("Solde bas");
    expect(described.reason).toMatch(/Compte courant/);
    expect(described.reason).toMatch(/42,50/);
    expect(described.reason).toMatch(/100,00/);
    expect(described.tone).toBe("warning");
  });

  it("marks a negative balance with the negative tone", () => {
    const described = describeAlert({
      kind: "LOW_BALANCE",
      inputs: { accountName: "Compte courant", currency: "EUR", balance: "-10.00", threshold: "0.00" },
    });

    expect(described.reason).toMatch(/négatif/);
    expect(described.tone).toBe("negative");
  });

  it("reads an overrun with the month label and the percentage", () => {
    const described = describeAlert({
      kind: "BUDGET_OVERRUN",
      inputs: {
        categoryName: "Courses",
        currency: "EUR",
        month: "2026-10",
        planned: "300.00",
        actual: "320.00",
        overrun: "20.00",
        overrunPercent: "6.7",
      },
    });

    expect(described.reason).toMatch(/Courses/);
    expect(described.reason).toMatch(/320,00/);
    expect(described.reason).toMatch(/300,00/);
    expect(described.reason).toMatch(/octobre 2026/);
    expect(described.reason).toMatch(/6,7 %/);
    expect(described.tone).toBe("negative");
  });

  it("reads an unusual expense with its date and threshold", () => {
    const described = describeAlert({
      kind: "UNUSUAL_EXPENSE",
      inputs: {
        label: "Achat ordinateur",
        amount: "1250.00",
        currency: "EUR",
        date: "2026-10-03",
        threshold: "500.00",
      },
    });

    expect(described.reason).toMatch(/Achat ordinateur/);
    // French formatting: thousands separated by a narrow no-break space.
    expect(described.reason).toMatch(/1\s250,00/);
    expect(described.reason).toMatch(/03\/10\/2026/);
    expect(described.reason).toMatch(/500,00/);
  });

  it("reads a stale integration with its provider label and pluralised days", () => {
    const described = describeAlert({
      kind: "STALE_INTEGRATION",
      inputs: {
        provider: "GITHUB",
        instance: "github.com",
        lastSyncedAt: "2026-10-04T12:00:00.000Z",
        daysSince: "2",
        thresholdDays: "1",
      },
    });

    expect(described.reason).toMatch(/GitHub \(github\.com\)/);
    expect(described.reason).toMatch(/2 jours/);
    expect(described.reason).toMatch(/1 jour/);
  });

  it("reads an overdue event, including the unknown amount case", () => {
    const described = describeAlert({
      kind: "OVERDUE_EVENT",
      inputs: {
        propertyName: "Rez-de-chaussée",
        label: "Loyer",
        currency: "EUR",
        amount: "950.00",
        dueDate: "2026-09-15",
        daysLate: "21",
        thresholdDays: "0",
      },
    });

    expect(described.reason).toMatch(/Loyer/);
    expect(described.reason).toMatch(/15\/09\/2026/);
    expect(described.reason).toMatch(/21 jours/);
    expect(described.reason).toMatch(/950,00/);

    const unknown = describeAlert({
      kind: "OVERDUE_EVENT",
      inputs: {
        propertyName: "Rez-de-chaussée",
        label: "Loyer",
        currency: "EUR",
        amount: null,
        dueDate: "2026-09-15",
        daysLate: "21",
        thresholdDays: "0",
      },
    });

    expect(unknown.reason).toMatch(/montant inconnu/);
  });

  it("explains unreadable inputs instead of rendering a blank reason", () => {
    const described = describeAlert({ kind: "BUDGET_OVERRUN", inputs: { nonsense: true } });

    expect(described.reason).toMatch(/relancez une vérification/);
    expect(described.title).toBe("Dépassement de budget");
  });
});

describe("resolveAlertRules", () => {
  it("returns the defaults, in canonical order, before any configuration is saved", () => {
    const rules = resolveAlertRules([]);

    expect(rules.map((rule) => rule.kind)).toEqual([...ALERT_KINDS]);
    expect(rules.every((rule) => rule.enabled)).toBe(true);

    const lowBalance = rules[0];
    expect(lowBalance.thresholdAmount?.toFixed(2)).toBe("0.00");

    const threshold = rules[2];
    expect(threshold.thresholdPercent?.toFixed(2)).toBe("80.00");

    const unusual = rules[3];
    expect(unusual.thresholdAmount?.toFixed(2)).toBe("500.00");
    expect(unusual.thresholdCurrency).toBe("EUR");

    expect(rules[4].thresholdDays).toBe(1);
    expect(rules[5].thresholdDays).toBe(0);
  });

  it("lets a stored row override the defaults, field by field", () => {
    const rules = resolveAlertRules([
      {
        kind: "LOW_BALANCE",
        enabled: false,
        thresholdAmount: new Decimal("250"),
        thresholdCurrency: "USD",
        thresholdPercent: null,
        thresholdDays: null,
      },
      {
        kind: "STALE_INTEGRATION",
        enabled: true,
        thresholdAmount: null,
        thresholdCurrency: null,
        thresholdPercent: null,
        thresholdDays: 7,
      },
    ]);

    const lowBalance = rules.find((rule) => rule.kind === "LOW_BALANCE");
    expect(lowBalance?.enabled).toBe(false);
    expect(lowBalance?.thresholdAmount?.toFixed(2)).toBe("250.00");
    expect(lowBalance?.thresholdCurrency).toBe("USD");

    expect(rules.find((rule) => rule.kind === "STALE_INTEGRATION")?.thresholdDays).toBe(7);
    // Untouched kinds keep their defaults.
    expect(rules.find((rule) => rule.kind === "OVERDUE_EVENT")?.thresholdDays).toBe(0);
  });
});

const VALID_FORM = {
  lowBalance: { enabled: true, thresholdAmount: "100,00", thresholdCurrency: "EUR" },
  budgetOverrun: { enabled: true, thresholdPercent: "10" },
  budgetThreshold: { enabled: true, thresholdPercent: "80" },
  unusualExpense: { enabled: true, thresholdAmount: "500", thresholdCurrency: "EUR" },
  staleIntegration: { enabled: true, thresholdDays: "2" },
  overdueEvent: { enabled: true, thresholdDays: "0" },
  aiBudgetOverrun: { enabled: true, thresholdPercent: "5" },
  aiBudgetThreshold: { enabled: true, thresholdPercent: "75" },
};

describe("alertRulesInputSchema", () => {
  it("accepts a complete configuration and normalises it", () => {
    const parsed = alertRulesInputSchema.safeParse(VALID_FORM);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lowBalance.thresholdAmount?.toFixed(2)).toBe("100.00");
      expect(parsed.data.budgetOverrun.thresholdPercent?.toFixed(2)).toBe("10.00");
      expect(parsed.data.staleIntegration.thresholdDays).toBe(2);
      expect(parsed.data.overdueEvent.thresholdDays).toBe(0);
    }
  });

  it("accepts empty fields: an empty threshold falls back to the default", () => {
    const parsed = alertRulesInputSchema.safeParse({
      lowBalance: { enabled: true, thresholdAmount: "", thresholdCurrency: "" },
      budgetOverrun: { enabled: false, thresholdPercent: "" },
      budgetThreshold: { enabled: false, thresholdPercent: "" },
      unusualExpense: { enabled: false, thresholdAmount: "", thresholdCurrency: "" },
      staleIntegration: { enabled: true, thresholdDays: "" },
      overdueEvent: { enabled: false, thresholdDays: "" },
      aiBudgetOverrun: { enabled: false, thresholdPercent: "" },
      aiBudgetThreshold: { enabled: true, thresholdPercent: "" },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lowBalance.thresholdAmount).toBeNull();
      expect(parsed.data.lowBalance.thresholdCurrency).toBeNull();
      expect(parsed.data.staleIntegration.thresholdDays).toBeNull();
    }
  });

  it("refuses a positive low-balance threshold without a currency", () => {
    const parsed = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      lowBalance: { enabled: true, thresholdAmount: "100", thresholdCurrency: "" },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join(".") === "lowBalance.thresholdCurrency")).toBe(true);
    }
  });

  it("accepts a zero low-balance threshold without a currency: zero reads the same everywhere", () => {
    const parsed = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      lowBalance: { enabled: true, thresholdAmount: "0", thresholdCurrency: "" },
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a negative low-balance threshold", () => {
    const parsed = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      lowBalance: { enabled: true, thresholdAmount: "-1", thresholdCurrency: "EUR" },
    });

    expect(parsed.success).toBe(false);
  });

  it("requires a positive amount and a currency for an enabled unusual-expense rule", () => {
    const noAmount = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      unusualExpense: { enabled: true, thresholdAmount: "", thresholdCurrency: "EUR" },
    });
    expect(noAmount.success).toBe(false);

    const noCurrency = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      unusualExpense: { enabled: true, thresholdAmount: "500", thresholdCurrency: "" },
    });
    expect(noCurrency.success).toBe(false);

    // Disabled with empty fields is a valid "off" state.
    const off = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      unusualExpense: { enabled: false, thresholdAmount: "", thresholdCurrency: "" },
    });
    expect(off.success).toBe(true);
  });

  it("bounds the percentage and the day counts", () => {
    const hugePercent = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      budgetOverrun: { enabled: true, thresholdPercent: "5000" },
    });
    expect(hugePercent.success).toBe(false);

    const negativeDays = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      overdueEvent: { enabled: true, thresholdDays: "-1" },
    });
    expect(negativeDays.success).toBe(false);

    const fractionalDays = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      overdueEvent: { enabled: true, thresholdDays: "2.5" },
    });
    expect(fractionalDays.success).toBe(false);
  });

  it("refuses a stale threshold under one day", () => {
    const parsed = alertRulesInputSchema.safeParse({
      ...VALID_FORM,
      staleIntegration: { enabled: true, thresholdDays: "0" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("toAlertRulesFormValues", () => {
  it("round-trips the effective configuration into strings the form can edit", () => {
    const values = toAlertRulesFormValues(resolveAlertRules([]));

    expect(values.lowBalance).toEqual({ enabled: true, thresholdAmount: "0.00", thresholdCurrency: "" });
    expect(values.unusualExpense.thresholdAmount).toBe("500.00");
    expect(values.unusualExpense.thresholdCurrency).toBe("EUR");
    expect(values.staleIntegration.thresholdDays).toBe("1");
    expect(values.overdueEvent.thresholdDays).toBe("0");

    // The strings feed the same schema the action validates with.
    expect(alertRulesInputSchema.safeParse(values).success).toBe(true);
  });
});
