import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { renderSituationSummary } from "./summary-markdown";
import {
  SUMMARY_SECTIONS,
  SUMMARY_SECTION_TITLES,
  type SituationSummary,
  type SummaryFinance,
  type SummarySectionKey,
} from "./summary";

/** Fictitious data only: these tests pin the wording and the unknown-versus-zero rule. */

function sectionsFor(excluded: Partial<Record<SummarySectionKey, string>> = {}) {
  return SUMMARY_SECTIONS.map((key) => ({
    key,
    title: SUMMARY_SECTION_TITLES[key],
    included: !(key in excluded),
    reason: excluded[key] ?? null,
  }));
}

function emptyFinance(overrides: Partial<SummaryFinance> = {}): SummaryFinance {
  return {
    accounts: [],
    accountTotals: [],
    series: [],
    reference: {
      monthKey: "2026-11",
      actuals: [],
      budgets: { lines: [], totals: [] },
      pending: [],
      totals: [],
    },
    salary: { hoursPerDay: null, currency: null, equivalents: null, months: [] },
    schedule: [],
    savings: [],
    goals: [],
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<SituationSummary> = {}): SituationSummary {
  return {
    generatedAt: new Date("2026-11-16T08:00:00.000Z"),
    scope: "all",
    monthKey: "2026-11",
    monthLabel: "novembre 2026",
    horizon: 1,
    horizonKeys: ["2026-12"],
    workspace: { name: "Espace fictif", kind: "PERSONAL" },
    defaultCurrency: "EUR",
    timeZone: "Europe/Paris",
    modules: ["budget"],
    sections: sectionsFor(),
    truncated: [],
    finance: emptyFinance(),
    realEstate: null,
    microBusiness: null,
    integrations: null,
    alerts: [],
    ...overrides,
  };
}

describe("renderSituationSummary", () => {
  it("states the reference period and the reading conventions", () => {
    const markdown = renderSituationSummary(summaryFixture());

    expect(markdown).toContain("# Synthèse de situation — novembre 2026");
    expect(markdown).toContain("| Mois de référence | 2026-11 — novembre 2026 |");
    expect(markdown).toContain("## Comment lire ce document");
    expect(markdown).toContain("**« inconnu »**");
    expect(markdown).toContain("Aucune conversion");
    expect(markdown).toContain("`AAAA-MM-JJ`");
  });

  it("renders an unrecorded balance as unknown, never as zero", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        finance: emptyFinance({
          accounts: [
            {
              name: "Compte courant",
              type: "CHECKING",
              currency: "EUR",
              balance: null,
              lastOperationOn: null,
            },
          ],
          accountTotals: [{ currency: "EUR", balance: new Decimal(0), knownAccounts: 0, unknownAccounts: 1 }],
        }),
      }),
    );

    expect(markdown).toContain("| Compte courant | Compte courant | EUR | inconnu | — |");
    expect(markdown).toContain("Total enregistré en EUR : inconnu");
    expect(markdown).toContain("1 compte sans opération");
    expect(markdown).not.toContain("Total enregistré en EUR : 0.00");
  });

  it("marks a section without data instead of inventing figures", () => {
    const markdown = renderSituationSummary(summaryFixture());

    expect(markdown).toContain("| Séries récurrentes | incluse — aucune donnée enregistrée |");
    expect(markdown).toContain("Aucune série récurrente.");
    expect(markdown).toContain("Aucun compte enregistré.");
    expect(markdown).toContain("Aucune alerte active.");
  });

  it("explains an excluded section and leaves its body out", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        scope: "finance",
        sections: sectionsFor({ properties: "exclue par le périmètre demandé (scope=finance)" }),
      }),
    );

    expect(markdown).toContain(
      "| Biens immobiliers | non incluse — exclue par le périmètre demandé (scope=finance) |",
    );
    expect(markdown).not.toContain("## Biens immobiliers");
    expect(markdown).toContain("finance personnelle — module budget uniquement");
  });

  it("keeps a pipe and a line break of a stored label inside its cell", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        finance: emptyFinance({
          series: [
            {
              label: "Loyer | charges\nappartement",
              type: "EXPENSE",
              amount: new Decimal("780.50"),
              currency: "EUR",
              frequency: "MONTHLY",
              accountName: "Compte courant",
              categoryName: null,
              startDate: new Date("2026-01-05T00:00:00.000Z"),
              endDate: null,
            },
          ],
        }),
      }),
    );

    expect(markdown).toContain("Loyer \\| charges appartement |");
    expect(markdown).not.toContain("Loyer | charges\nappartement");
  });

  it("says when a section is a prefix of the data", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        truncated: ["series"],
        finance: emptyFinance({
          series: [
            {
              label: "Loyer",
              type: "EXPENSE",
              amount: new Decimal("780.50"),
              currency: "EUR",
              frequency: "MONTHLY",
              accountName: "Compte courant",
              categoryName: "Logement",
              startDate: new Date("2026-01-05T00:00:00.000Z"),
              endDate: null,
            },
          ],
        }),
      }),
    );

    expect(markdown).toContain("> Lecture tronquée");
  });

  it("renders the month's forecast, the pending movements and the schedule", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        finance: emptyFinance({
          reference: {
            monthKey: "2026-11",
            actuals: [
              {
                currency: "EUR",
                transactionCount: 2,
                income: new Decimal("2100.00"),
                expenses: new Decimal("780.50"),
                transfers: new Decimal(0),
                net: new Decimal("1319.50"),
              },
            ],
            budgets: { lines: [], totals: [] },
            pending: [
              {
                date: new Date("2026-11-28T00:00:00.000Z"),
                label: "Salaire simulé",
                type: "INCOME",
                amount: new Decimal("1200.00"),
                currency: "EUR",
                status: "PENDING",
                source: "SALARY",
              },
            ],
            totals: [
              {
                currency: "EUR",
                income: new Decimal("1200.00"),
                expenses: new Decimal("780.50"),
                net: new Decimal("419.50"),
                count: 2,
                confirmedCount: 0,
              },
            ],
          },
          schedule: [
            {
              monthKey: "2026-12",
              totals: [
                {
                  currency: "EUR",
                  income: new Decimal("2100.00"),
                  expenses: new Decimal("780.50"),
                  net: new Decimal("1319.50"),
                  count: 2,
                  confirmedCount: 0,
                },
              ],
              balances: [{ currency: "EUR", balance: new Decimal("1319.50") }],
            },
          ],
        }),
      }),
    );

    expect(markdown).toContain("| EUR | 2100.00 | 780.50 | 0.00 | 1319.50 | 2 |");
    expect(markdown).toContain("| EUR | 1200.00 | 780.50 | 419.50 | 2 | 0 |");
    expect(markdown).toContain("| 2026-11-28 | Salaire simulé | Recette | 1200.00 | EUR | salaire simulé |");
    expect(markdown).toContain("| 2026-12 | EUR | 2100.00 | 780.50 | 1319.50 | 1319.50 | 2 |");
  });

  it("says a simulated balance is unknown for a currency nothing was recorded in", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        finance: emptyFinance({
          schedule: [
            {
              monthKey: "2026-12",
              totals: [
                {
                  currency: "USD",
                  income: new Decimal(0),
                  expenses: new Decimal("50.00"),
                  net: new Decimal("-50.00"),
                  count: 1,
                  confirmedCount: 0,
                },
              ],
              balances: [],
            },
          ],
        }),
      }),
    );

    expect(markdown).toContain("| 2026-12 | USD | 0.00 | 50.00 | -50.00 | inconnu | 1 |");
  });

  it("lists the active alerts with their reason", () => {
    const markdown = renderSituationSummary(
      summaryFixture({
        alerts: [
          {
            kind: "LOW_BALANCE",
            triggeredAt: new Date("2026-11-15T09:30:00.000Z"),
            title: "Solde bas",
            reason: "Compte courant : solde -10.00 EUR sous le seuil 0.00.",
          },
        ],
      }),
    );

    expect(markdown).toContain(
      "| Solde bas | 2026-11-15T09:30:00.000Z | Compte courant : solde -10.00 EUR sous le seuil 0.00. |",
    );
  });

  it("starts with a single heading and ends with one newline", () => {
    const markdown = renderSituationSummary(summaryFixture());

    expect(markdown.startsWith("# Synthèse de situation")).toBe(true);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});
