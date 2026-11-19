import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import {
  buildAiCostOverview,
  currentBillingCycle,
  type AiCostOverviewDto,
  type OverviewEntryRow,
  type OverviewLedger,
} from "./overview";

const TZ = "Europe/Paris";
const cycle = currentBillingCycle(parseDateOnly("2026-11-19"));

function entry(amount: string, overrides: Partial<OverviewEntryRow> = {}): OverviewEntryRow {
  return {
    amount: new Decimal(amount),
    currency: "EUR",
    actuality: "OBSERVED",
    periodEnd: parseDateOnly("2026-11-10"),
    ...overrides,
  };
}

function ok(entries: OverviewEntryRow[], sources: Extract<OverviewLedger, { state: "ok" }>["sources"] = []) {
  return buildAiCostOverview({ state: "ok", entries, sources }, cycle, TZ);
}

const kpi = (overview: AiCostOverviewDto, key: string) =>
  overview.kpis.find((candidate) => candidate.key === key)!;

/** Every leaf of the DTO is a string or null: no Decimal and no Date reaches the page. */
function assertStringsOnly(value: unknown): void {
  if (value === null || typeof value === "string") return;
  if (Array.isArray(value)) return value.forEach(assertStringsOnly);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  Object.values(value as object).forEach(assertStringsOnly);
}

describe("currentBillingCycle", () => {
  it("is the calendar month containing today", () => {
    expect(cycle.start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("buildAiCostOverview", () => {
  it("returns strings only, and every KPI documents formula, period and sources", () => {
    const overview = ok([entry("12.50")], [
      { sourceKind: "MANUAL", sourceProvider: null, sourceCapturedAt: new Date("2026-11-18T10:00:00Z") },
    ]);

    assertStringsOnly(overview);
    for (const item of overview.kpis) {
      expect(item.formula).not.toBe("");
      expect(item.period).not.toBe("");
      expect(item.sources).not.toBe("");
    }
  });

  it("sums exactly per currency, refunds included, without converting", () => {
    const overview = ok([
      entry("0.10"),
      entry("0.20"),
      entry("-5.00", { actuality: "RECONCILED" }),
      entry("3.00", { currency: "USD", actuality: "ESTIMATED" }),
    ]);

    const spend = kpi(overview, "spend");
    expect(spend.state).toBe("ok");
    expect(spend.value).toContain("-4,70");
    expect(spend.value).toContain("3,00");
    expect(spend.value).toContain("$");
    expect(overview.spendRows.map((row) => [row.currency, row.actuality, row.entryCount])).toEqual([
      ["EUR", "Constaté", "2"],
      ["EUR", "Rapproché", "1"],
      ["USD", "Estimé", "1"],
    ]);
  });

  it("flags an entry that runs past the cycle end", () => {
    const overview = ok([entry("1.00", { periodEnd: parseDateOnly("2026-12-15") })]);
    expect(kpi(overview, "spend").detail).toContain("dont 1 se prolongeant");
  });

  it("reads an empty cycle as no data, never as zero", () => {
    const overview = ok([]);
    const spend = kpi(overview, "spend");

    expect(spend.state).toBe("no-data");
    expect(spend.value).toBeNull();
    expect(overview.spendRows).toEqual([]);
    expect(overview.freshness[0]).toMatchObject({ source: "Registre des coûts", state: "no-data" });
  });

  it("marks KPIs without a data source as not connected", () => {
    const overview = ok([entry("1.00")]);

    for (const key of ["forecast", "requests", "tokens", "cache-rate"]) {
      expect(kpi(overview, key)).toMatchObject({ state: "not-connected", value: null });
    }
    expect(overview.freshness.at(-1)).toMatchObject({
      source: "Fournisseurs IA (API)",
      state: "not-connected",
    });
  });

  it("lists each source's last capture and drops the provider placeholder once one exists", () => {
    const overview = ok([], [
      { sourceKind: "PROVIDER", sourceProvider: "openai", sourceCapturedAt: new Date("2026-11-18T10:00:00Z") },
    ]);

    expect(overview.freshness).toEqual([
      {
        source: "Fournisseur : openai",
        state: "ok",
        lastCapturedAt: "18/11/2026 11:00",
        detail: null,
      },
    ]);
  });

  it("shows a ledger read failure as an error, not as an empty cycle", () => {
    const overview = buildAiCostOverview({ state: "error" }, cycle, TZ);

    expect(kpi(overview, "spend")).toMatchObject({ state: "error", value: null });
    expect(overview.spendRows).toEqual([]);
    expect(overview.freshness).toEqual([expect.objectContaining({ state: "error" })]);
  });

  it("reads spend against the workspace budget, and no budget as no data rather than 0 %", () => {
    expect(kpi(ok([entry("1.00")]), "budget")).toMatchObject({ state: "no-data", value: null });

    const withBudget = buildAiCostOverview(
      { state: "ok", entries: [entry("150.00")], sources: [] },
      cycle,
      TZ,
      [{ cap: "200,00 €", spent: "150,00 €", percent: "75,0 %" }],
    );
    expect(kpi(withBudget, "budget")).toMatchObject({ state: "ok", value: "75,0 % de 200,00 €" });

    const noSpendInCurrency = buildAiCostOverview(
      { state: "ok", entries: [entry("1.00")], sources: [] },
      cycle,
      TZ,
      [{ cap: "200,00 $US", spent: null, percent: null }],
    );
    expect(kpi(noSpendInCurrency, "budget").state).toBe("no-data");

    expect(kpi(buildAiCostOverview({ state: "error" }, cycle, TZ), "budget").state).toBe("error");
  });

  it("measures cycle progress with today included", () => {
    expect(kpi(ok([]), "cycle-progress")).toMatchObject({ value: "63 %", detail: "Jour 19 sur 30" });

    const lastDay = currentBillingCycle(parseDateOnly("2026-11-30"));
    const progress = buildAiCostOverview({ state: "ok", entries: [], sources: [] }, lastDay, TZ);
    expect(kpi(progress, "cycle-progress").value).toBe("100 %");
  });
});
