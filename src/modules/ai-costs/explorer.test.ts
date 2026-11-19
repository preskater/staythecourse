import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import {
  clampPage,
  EXPLORER_PAGE_SIZE,
  explorerHref,
  explorerWhere,
  FILTER_NONE,
  parseExplorerFilters,
  toEntryDto,
  toGroupDtos,
  totalsByCurrency,
  type ExplorerEntryRow,
  type ExplorerOptions,
} from "./explorer";
import { buildAiCostOverview, currentBillingCycle } from "./overview";

const cycle = currentBillingCycle(parseDateOnly("2026-11-19"));

const options: ExplorerOptions = {
  provider: ["anthropic", "openai"],
  project: ["proj-a", "proj-b"],
  client: ["client-1"],
  developer: ["dev-1"],
  repository: ["org/app"],
  agent: [],
  environment: ["production"],
};

const parse = (params: Record<string, string>) => parseExplorerFilters(params, options, cycle);

describe("parseExplorerFilters", () => {
  it("defaults to the current cycle, grouped by provider, first page, no filter", () => {
    const filters = parse({});

    expect(filters.from.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(filters.to.toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(filters.groupBy).toBe("provider");
    expect(filters.page).toBe(1);
    expect(Object.values(filters.dimensions).every((value) => value === null)).toBe(true);
  });

  it("keeps known values and `none`, and ignores unknown ones instead of matching nothing", () => {
    const filters = parse({ provider: "openai", project: FILTER_NONE, client: "ghost", agent: "x" });

    expect(filters.dimensions).toMatchObject({
      provider: "openai",
      project: FILTER_NONE,
      client: null,
      agent: null,
    });
  });

  it("falls back on invalid dates, swaps an inverted range and rejects a bad page or grouping", () => {
    const filters = parse({ from: "2026-10-31", to: "2026-10-01", page: "-3", by: "secret" });
    expect(filters.from.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(filters.to.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(filters.page).toBe(1);
    expect(filters.groupBy).toBe("provider");

    expect(parse({ from: "2026-02-31" }).from).toEqual(cycle.start);
    expect(parse({ page: "1e9999" }).page).toBe(1);
  });
});

describe("explorerWhere", () => {
  it("combines every active filter with the workspace and the period", () => {
    const where = explorerWhere(
      "ws-1",
      parse({ provider: "openai", project: FILTER_NONE, repository: "org/app", environment: "production" }),
    );

    expect(where).toEqual({
      workspaceId: "ws-1",
      periodStart: { gte: cycle.start, lte: parseDateOnly("2026-11-30") },
      sourceProvider: "openai",
      projectId: null,
      repository: "org/app",
      environment: "production",
    });
  });

  it("never lets a URL value reach the query unvalidated", () => {
    expect(explorerWhere("ws-1", parse({ client: "' OR 1=1 --" }))).not.toHaveProperty("clientId");
  });
});

describe("pagination", () => {
  it("clamps a page past the end to the last page, and an empty result to page 1", () => {
    expect(clampPage(99, EXPLORER_PAGE_SIZE * 2 + 1)).toEqual({ page: 3, pageCount: 3 });
    expect(clampPage(5, 0)).toEqual({ page: 1, pageCount: 1 });
    expect(clampPage(2, EXPLORER_PAGE_SIZE)).toEqual({ page: 1, pageCount: 1 });
  });
});

describe("drill-down links", () => {
  it("adds the group's value to the current filters and restarts at page 1", () => {
    const filters = { ...parse({ provider: "openai", by: "project" }), page: 3 };
    const [withProject, withoutProject] = toGroupDtos(
      [
        { value: "proj-a", currency: "EUR", amount: new Decimal("10"), count: 2 },
        { value: null, currency: "EUR", amount: new Decimal("1"), count: 1 },
      ],
      filters,
    );

    const drill = new URL(withProject.href, "http://x").searchParams;
    expect(drill.get("tab")).toBe("explorer");
    expect(drill.get("provider")).toBe("openai");
    expect(drill.get("project")).toBe("proj-a");
    expect(drill.has("page")).toBe(false);
    expect(new URL(withoutProject.href, "http://x").searchParams.get("project")).toBe(FILTER_NONE);
    expect(withoutProject.label).toBe("Non renseigné");
  });

  it("removes a filter when its value is null", () => {
    const href = explorerHref(parse({ provider: "openai" }), { provider: null });
    expect(new URL(href, "http://x").searchParams.has("provider")).toBe(false);
  });
});

describe("totals", () => {
  it("reconcile with the overview's spend for the same entries, per currency", () => {
    const amounts = [
      { amount: "0.10", currency: "EUR" },
      { amount: "0.20", currency: "EUR" },
      { amount: "-5.00", currency: "EUR" },
      { amount: "3.00", currency: "USD" },
    ];

    const overview = buildAiCostOverview(
      {
        state: "ok",
        entries: amounts.map((row) => ({
          ...row,
          actuality: "OBSERVED",
          periodEnd: parseDateOnly("2026-11-10"),
        })),
        sources: [],
      },
      cycle,
      "Europe/Paris",
    );
    // Groups as `GROUP BY provider, currency` would return them.
    const explorer = totalsByCurrency([
      { value: "openai", currency: "EUR", amount: new Decimal("0.30"), count: 2 },
      { value: null, currency: "EUR", amount: new Decimal("-5.00"), count: 1 },
      { value: "openai", currency: "USD", amount: new Decimal("3.00"), count: 1 },
    ]);

    expect(explorer.join(" · ")).toBe(overview.kpis.find((kpi) => kpi.key === "spend")!.value);
  });
});

describe("toEntryDto", () => {
  const row: ExplorerEntryRow = {
    id: "entry-1",
    amount: new Decimal("12.5"),
    currency: "EUR",
    actuality: "OBSERVED",
    sourceKind: "MANUAL",
    sourceProvider: null,
    sourceExternalId: null,
    sourceImportId: null,
    sourceRowNumber: null,
    sourceCapturedAt: new Date("2026-11-18T10:00:00Z"),
    periodStart: parseDateOnly("2026-11-01"),
    periodEnd: parseDateOnly("2026-11-30"),
    projectId: "proj-a",
    clientId: null,
    developerId: null,
    repository: null,
    agentId: null,
    environment: null,
    status: "DRAFT",
  };

  it("returns strings only and traces the source", () => {
    const dto = toEntryDto(row, "Europe/Paris");

    expect(Object.values(dto).every((value) => typeof value === "string")).toBe(true);
    expect(dto).toMatchObject({
      source: "Saisie manuelle",
      actuality: "Constaté",
      dimensions: "Projet : proj-a",
      status: "Brouillon",
    });
    expect(dto.amount).toContain("12,50");
  });

  it("names a provider source by provider and external identifier", () => {
    const dto = toEntryDto(
      { ...row, sourceKind: "PROVIDER", sourceProvider: "openai", sourceExternalId: "inv-42" },
      "Europe/Paris",
    );
    expect(dto.source).toBe("Fournisseur openai · inv-42");
  });
});
