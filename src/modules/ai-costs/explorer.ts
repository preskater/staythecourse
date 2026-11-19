import Decimal from "decimal.js";
import { formatDateOnly, formatInstant, parseDateOnly, toDateOnlyString } from "@/lib/dates";
import { assertCurrency, formatMoney, money } from "@/lib/money";
import { readSearchParam, type SearchParamsInput } from "@/lib/search-params";
import { ACTUALITY_LABELS } from "./actuality";
import { fromStoredActuality } from "./ledger";
import type { BillingCycle } from "./overview";

/**
 * Multidimensional cost explorer (M12-02).
 *
 * Filters live in the URL and combine with AND. Like the issues explorer, a value is
 * kept only if it exists in the workspace's ledger (or is `none`, "not set"): an
 * unknown value is dropped, never turned into a filter matching nothing.
 *
 * Filters apply to the entry's own dimensions, the same rows the overview sums, so the
 * explorer's unfiltered total over the current cycle reconciles with the overview.
 *
 * ponytail: allocations (M9-02 `CostAllocation`) are not used to attribute a share of
 * an entry to another dimension; switch to allocated amounts once M9-03's allocation
 * policies land. The ledger has no model or API-key column: those dimensions are
 * absent rather than invented.
 */

export const FILTER_NONE = "none";

/** Each dimension: its URL parameter, its ledger column and its label. */
export const EXPLORER_DIMENSIONS = [
  { param: "provider", column: "sourceProvider", label: "Fournisseur" },
  { param: "project", column: "projectId", label: "Projet" },
  { param: "client", column: "clientId", label: "Client" },
  { param: "developer", column: "developerId", label: "Développeur" },
  { param: "repository", column: "repository", label: "Dépôt" },
  { param: "agent", column: "agentId", label: "Agent" },
  { param: "environment", column: "environment", label: "Environnement" },
] as const;

export type ExplorerDimension = (typeof EXPLORER_DIMENSIONS)[number];
export type DimensionParam = ExplorerDimension["param"];
export type DimensionColumn = ExplorerDimension["column"];

export const EXPLORER_PAGE_SIZE = 50;

/** The values each dimension actually holds in the workspace's ledger. */
export type ExplorerOptions = Record<DimensionParam, readonly string[]>;

export type ExplorerFilters = {
  /** `null` = no filter; `FILTER_NONE` = entries where the dimension is not set. */
  dimensions: Record<DimensionParam, string | null>;
  /** Inclusive bounds on the entry's period start. */
  from: Date;
  to: Date;
  groupBy: DimensionParam;
  page: number;
};

function dimension(param: DimensionParam): ExplorerDimension {
  return EXPLORER_DIMENSIONS.find((candidate) => candidate.param === param)!;
}

function readDate(params: SearchParamsInput, key: string): Date | null {
  const value = readSearchParam(params, key);
  if (!value) return null;
  try {
    return parseDateOnly(value);
  } catch {
    return null;
  }
}

/**
 * Validated filters from the query string.
 *
 * The period defaults to the current cycle (as the overview); an invalid date falls
 * back to its default, and an inverted range is swapped rather than read as empty.
 */
export function parseExplorerFilters(
  params: SearchParamsInput,
  options: ExplorerOptions,
  cycle: BillingCycle,
): ExplorerFilters {
  const dimensions = Object.fromEntries(
    EXPLORER_DIMENSIONS.map(({ param }) => {
      const value = readSearchParam(params, param);
      const known = value === FILTER_NONE || (value !== undefined && options[param].includes(value));
      return [param, known ? value : null];
    }),
  ) as Record<DimensionParam, string | null>;

  let from = readDate(params, "from") ?? cycle.start;
  let to = readDate(params, "to") ?? new Date(cycle.end.getTime() - 86_400_000);
  if (from > to) [from, to] = [to, from];

  const groupBy =
    EXPLORER_DIMENSIONS.find(({ param }) => param === readSearchParam(params, "by"))?.param ??
    "provider";
  const page = Number.parseInt(readSearchParam(params, "page") ?? "1", 10);

  return {
    dimensions,
    from,
    to,
    groupBy,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** The Prisma filter of a workspace's entries for these filters. Server-built, never raw. */
export function explorerWhere(workspaceId: string, filters: ExplorerFilters) {
  const where: Record<string, unknown> = {
    workspaceId,
    periodStart: { gte: filters.from, lte: filters.to },
  };

  for (const { param, column } of EXPLORER_DIMENSIONS) {
    const value = filters.dimensions[param];
    if (value !== null) where[column] = value === FILTER_NONE ? null : value;
  }

  return where;
}

/** Clamps the requested page to the last one, so a stale `?page=` never shows a void. */
export function clampPage(page: number, total: number): { page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(total / EXPLORER_PAGE_SIZE));
  return { page: Math.min(page, pageCount), pageCount };
}

/** The query string of these filters with `changes` applied; `null` removes a key. */
export function explorerHref(
  filters: ExplorerFilters,
  changes: Partial<Record<DimensionParam | "by" | "page" | "from" | "to", string | null>> = {},
): string {
  const params = new URLSearchParams({ tab: "explorer" });
  for (const { param } of EXPLORER_DIMENSIONS) {
    const value = filters.dimensions[param];
    if (value !== null) params.set(param, value);
  }
  params.set("from", toDateOnlyString(filters.from));
  params.set("to", toDateOnlyString(filters.to));
  params.set("by", filters.groupBy);

  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined) params.delete(key);
    else params.set(key, value);
  }
  // Any change of scope restarts at the first page.
  if (!("page" in changes)) params.delete("page");

  return `/ai-costs?${params.toString()}`;
}

/* ----------------------------------------------------------------------------- DTOs */

export type ExplorerGroupRow = {
  /** Raw dimension value, or `null` when not set. */
  value: string | null;
  currency: string;
  amount: Decimal.Value;
  count: number;
};

export type ExplorerEntryRow = {
  id: string;
  amount: Decimal.Value;
  currency: string;
  actuality: string;
  sourceKind: string;
  sourceProvider: string | null;
  sourceExternalId: string | null;
  sourceImportId: string | null;
  sourceRowNumber: number | null;
  sourceCapturedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  projectId: string | null;
  clientId: string | null;
  developerId: string | null;
  repository: string | null;
  agentId: string | null;
  environment: string | null;
  status: string;
};

export type ExplorerGroupDto = {
  label: string;
  currency: string;
  amount: string;
  entryCount: string;
  /** Drill-down: the same view filtered on this value. */
  href: string;
};

export type ExplorerEntryDto = {
  id: string;
  period: string;
  amount: string;
  actuality: string;
  source: string;
  capturedAt: string;
  dimensions: string;
  status: string;
};

const NOT_SET = "Non renseigné";

export function dimensionValueLabel(value: string | null): string {
  return value === null || value === FILTER_NONE ? NOT_SET : value;
}

function formatAmount(amount: Decimal.Value, currency: string): string {
  return formatMoney(money(new Decimal(amount.toString()), assertCurrency(currency)));
}

export function toGroupDtos(
  rows: readonly ExplorerGroupRow[],
  filters: ExplorerFilters,
): ExplorerGroupDto[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        new Decimal(b.amount.toString()).comparedTo(new Decimal(a.amount.toString())) ||
        dimensionValueLabel(a.value).localeCompare(dimensionValueLabel(b.value)),
    )
    .map((row) => ({
      label: dimensionValueLabel(row.value),
      currency: row.currency,
      amount: formatAmount(row.amount, row.currency),
      entryCount: String(row.count),
      href: explorerHref(filters, { [filters.groupBy]: row.value ?? FILTER_NONE }),
    }));
}

/** Per-currency totals of the filtered set, never converted. */
export function totalsByCurrency(rows: readonly ExplorerGroupRow[]): string[] {
  const totals = new Map<string, Decimal>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? new Decimal(0)).plus(row.amount.toString()));
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => formatAmount(total, currency));
}

function sourceLabel(row: ExplorerEntryRow): string {
  switch (row.sourceKind) {
    case "PROVIDER":
      return `Fournisseur ${row.sourceProvider ?? "?"} · ${row.sourceExternalId ?? "?"}`;
    case "IMPORT":
      return `Import ${row.sourceImportId ?? "?"} · ligne ${row.sourceRowNumber ?? "?"}`;
    default:
      // The author's identifier stays server-side: "manual" is enough to trace it here.
      return "Saisie manuelle";
  }
}

export function toEntryDto(row: ExplorerEntryRow, timeZone: string): ExplorerEntryDto {
  const dimensions = EXPLORER_DIMENSIONS.filter(({ column }) => column !== "sourceProvider")
    .map(({ column, label }) => (row[column] ? `${label} : ${row[column]}` : null))
    .filter(Boolean)
    .join(" · ");

  return {
    id: row.id,
    period: `${formatDateOnly(row.periodStart)} → ${formatDateOnly(row.periodEnd)}`,
    amount: formatAmount(row.amount, row.currency),
    actuality: ACTUALITY_LABELS[fromStoredActuality(row.actuality)],
    source: sourceLabel(row),
    capturedAt: formatInstant(row.sourceCapturedAt, { timeZone }),
    dimensions: dimensions || NOT_SET,
    status: row.status === "FINALIZED" ? "Clôturée" : "Brouillon",
  };
}

export function groupColumn(filters: ExplorerFilters): DimensionColumn {
  return dimension(filters.groupBy).column;
}
