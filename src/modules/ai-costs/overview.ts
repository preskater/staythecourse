import Decimal from "decimal.js";
import { formatDateOnly, formatInstant, monthRange } from "@/lib/dates";
import { assertCurrency, formatMoney, money } from "@/lib/money";
import { ACTUALITY_LABELS, type Actuality } from "./actuality";
import { fromStoredActuality } from "./ledger";

/**
 * AI cost overview (M12-01): the read-only first page of the « Coûts IA » module.
 *
 * Every KPI carries its formula, period and sources, and a state that keeps "no data",
 * "not connected" and an error apart: a missing figure is never rendered as zero.
 *
 * The ledger (`CostEntry`, M9-02) and the AI budgets (M12-03) feed figures today. The
 * billing-cycle forecast (M12-04) and usage metrics — requests, token classes, cache
 * hits — from the provider adapters (M11) have no data source yet, so those KPIs read
 * "not connected" until their milestone lands.
 *
 * The output is strings only: no `Decimal` and no `Date` crosses into the page.
 */

export type KpiState = "ok" | "no-data" | "not-connected" | "error";

export const KPI_STATE_LABELS: Record<KpiState, string> = {
  ok: "À jour",
  "no-data": "Aucune donnée",
  "not-connected": "Non connecté",
  error: "Erreur",
};

export type KpiDto = {
  key: string;
  label: string;
  state: KpiState;
  /** Formatted figure; `null` whenever the state is not `ok`. */
  value: string | null;
  /** Why the figure is what it is, or why it is missing. */
  detail: string | null;
  formula: string;
  period: string;
  sources: string;
};

export type SpendRowDto = {
  currency: string;
  actuality: string;
  amount: string;
  entryCount: string;
};

export type FreshnessRowDto = {
  source: string;
  state: KpiState;
  lastCapturedAt: string | null;
  detail: string | null;
};

export type AiCostOverviewDto = {
  cycleLabel: string;
  kpis: KpiDto[];
  spendRows: SpendRowDto[];
  freshness: FreshnessRowDto[];
};

/** A ledger row as the overview needs it: amount, currency, trust, period and source. */
export type OverviewEntryRow = {
  amount: Decimal.Value;
  currency: string;
  actuality: string;
  periodEnd: Date;
};

/** The most recent capture of one source (kind + provider). */
export type OverviewSourceRow = {
  sourceKind: string;
  sourceProvider: string | null;
  sourceCapturedAt: Date;
};

/** What the repository returned, or that the ledger could not be read at all. */
export type OverviewLedger =
  | { state: "ok"; entries: readonly OverviewEntryRow[]; sources: readonly OverviewSourceRow[] }
  | { state: "error" };

export type BillingCycle = {
  /** First day, inclusive (date-only, UTC midnight). */
  start: Date;
  /** First day of the next cycle, exclusive. */
  end: Date;
  /** Today, in the owner's time zone. */
  today: Date;
};

const DAY_MS = 86_400_000;

/**
 * The current billing cycle: the calendar month containing `today`.
 *
 * ponytail: calendar month only; switch to a configured cycle start day when the
 * billing-cycle forecast (M12-04) adds one.
 */
export function currentBillingCycle(today: Date): BillingCycle {
  const { start, end } = monthRange(today.getUTCFullYear(), today.getUTCMonth() + 1);
  return { start, end, today };
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  IMPORT: "Import de fichier",
  MANUAL: "Saisie manuelle",
};

function sourceLabel(row: OverviewSourceRow): string {
  return row.sourceKind === "PROVIDER"
    ? `Fournisseur : ${row.sourceProvider ?? "inconnu"}`
    : (SOURCE_KIND_LABELS[row.sourceKind] ?? row.sourceKind);
}

const LEDGER_SOURCES = "Registre des coûts (fournisseurs, imports, saisies manuelles)";
const LEDGER_ERROR = "Le registre des coûts n'a pas pu être lu. Réessayez plus tard.";

function cyclePeriod(cycle: BillingCycle): string {
  const last = new Date(cycle.end.getTime() - DAY_MS);
  return `Du ${formatDateOnly(cycle.start)} au ${formatDateOnly(last)} (mois civil)`;
}

function missing(
  base: Omit<KpiDto, "state" | "value" | "detail">,
  state: Exclude<KpiState, "ok">,
  detail: string,
): KpiDto {
  return { ...base, state, value: null, detail };
}

/** Per-currency totals, never converted: one currency per line, in a stable order. */
function totalsByCurrency(entries: readonly OverviewEntryRow[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const entry of entries) {
    const current = totals.get(entry.currency) ?? new Decimal(0);
    totals.set(entry.currency, current.plus(new Decimal(entry.amount.toString())));
  }
  return new Map([...totals].sort(([a], [b]) => a.localeCompare(b)));
}

function spendRows(entries: readonly OverviewEntryRow[]): SpendRowDto[] {
  const groups = new Map<string, { currency: string; actuality: Actuality; total: Decimal; count: number }>();

  for (const entry of entries) {
    const actuality = fromStoredActuality(entry.actuality);
    const key = `${entry.currency}:${actuality}`;
    const group = groups.get(key) ?? { currency: entry.currency, actuality, total: new Decimal(0), count: 0 };
    group.total = group.total.plus(new Decimal(entry.amount.toString()));
    group.count += 1;
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.actuality.localeCompare(b.actuality))
    .map((group) => ({
      currency: group.currency,
      actuality: ACTUALITY_LABELS[group.actuality],
      amount: formatMoney(money(group.total, assertCurrency(group.currency))),
      entryCount: String(group.count),
    }));
}

function spendKpi(ledger: OverviewLedger, cycle: BillingCycle): KpiDto {
  const base = {
    key: "spend",
    label: "Dépense du cycle",
    formula:
      "Somme des montants des entrées dont la période commence dans le cycle, remboursements (montants négatifs) inclus. Une ligne par devise, sans conversion.",
    period: cyclePeriod(cycle),
    sources: LEDGER_SOURCES,
  };

  if (ledger.state === "error") return missing(base, "error", LEDGER_ERROR);
  if (ledger.entries.length === 0) {
    return missing(base, "no-data", "Aucune entrée de coût sur ce cycle.");
  }

  const value = [...totalsByCurrency(ledger.entries)]
    .map(([currency, total]) => formatMoney(money(total, assertCurrency(currency))))
    .join(" · ");
  // An entry is counted in the cycle its period starts in, even if it runs past it.
  const overlapping = ledger.entries.filter((entry) => entry.periodEnd >= cycle.end).length;
  const detail = [
    `${ledger.entries.length} entrée(s)`,
    overlapping > 0 ? `dont ${overlapping} se prolongeant sur le cycle suivant` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return { ...base, state: "ok", value, detail };
}

function cycleProgressKpi(cycle: BillingCycle): KpiDto {
  const total = Math.round((cycle.end.getTime() - cycle.start.getTime()) / DAY_MS);
  const elapsed = Math.round((cycle.today.getTime() - cycle.start.getTime()) / DAY_MS) + 1;
  const percent = Math.floor((elapsed * 100) / total);

  return {
    key: "cycle-progress",
    label: "Progression du cycle",
    state: "ok",
    value: `${percent} %`,
    detail: `Jour ${elapsed} sur ${total}`,
    formula: "Jours écoulés (aujourd'hui inclus) ÷ nombre de jours du cycle, arrondi à l'inférieur.",
    period: cyclePeriod(cycle),
    sources: "Calendrier, dans le fuseau horaire configuré",
  };
}

/** A workspace-wide AI budget with its cycle spend, already formatted (M12-03). */
export type OverviewBudget = { cap: string; spent: string | null; percent: string | null };

/**
 * Spend against the workspace-wide AI budgets, one per currency. A budget whose
 * currency has no entry this cycle reads "no spend", never 0 %.
 */
function budgetKpi(ledger: OverviewLedger, cycle: BillingCycle, budgets: readonly OverviewBudget[]): KpiDto {
  const base = {
    key: "budget",
    label: "Dépense vs budget",
    formula:
      "Dépense du cycle ÷ budget IA « Tout l'espace », dans la devise du budget (aucune conversion).",
    period: cyclePeriod(cycle),
    sources: `${LEDGER_SOURCES} ; budgets IA`,
  };

  if (ledger.state === "error") return missing(base, "error", LEDGER_ERROR);
  if (budgets.length === 0) {
    return missing(base, "no-data", "Aucun budget IA pour tout l'espace : définissez-en un dans l'onglet Budgets.");
  }
  if (budgets.every((budget) => budget.percent === null)) {
    return missing(base, "no-data", `Aucune dépense dans la devise du budget (${budgets.map((b) => b.cap).join(" · ")}).`);
  }

  return {
    ...base,
    state: "ok",
    value: budgets
      .map((budget) => (budget.percent === null ? `— de ${budget.cap}` : `${budget.percent} de ${budget.cap}`))
      .join(" · "),
    detail: budgets
      .filter((budget) => budget.spent !== null)
      .map((budget) => `${budget.spent} dépensés sur ${budget.cap}`)
      .join(" · "),
  };
}

/** KPIs whose data source arrives with a later milestone: always "not connected" today. */
function pendingKpis(cycle: BillingCycle): KpiDto[] {
  const period = cyclePeriod(cycle);
  const usage = "Adaptateurs de consommation des fournisseurs IA (non connectés)";

  return [
    missing(
      {
        key: "forecast",
        label: "Prévision fin de cycle",
        formula: "Projection de la dépense jusqu'au dernier jour du cycle.",
        period,
        sources: "Prévision de cycle de facturation",
      },
      "not-connected",
      "La prévision n'est pas encore disponible : aucune extrapolation n'est affichée.",
    ),
    missing(
      {
        key: "requests",
        label: "Requêtes",
        formula: "Nombre de requêtes facturées par les fournisseurs sur le cycle.",
        period,
        sources: usage,
      },
      "not-connected",
      "Aucun fournisseur IA ne transmet sa consommation.",
    ),
    missing(
      {
        key: "tokens",
        label: "Classes de tokens",
        formula: "Tokens d'entrée, de sortie, écrits en cache et lus en cache, sur le cycle.",
        period,
        sources: usage,
      },
      "not-connected",
      "Aucun fournisseur IA ne transmet sa consommation.",
    ),
    missing(
      {
        key: "cache-rate",
        label: "Taux de cache",
        formula: "Tokens lus en cache ÷ (tokens d'entrée + tokens lus en cache).",
        period,
        sources: usage,
      },
      "not-connected",
      "Aucun fournisseur IA ne transmet sa consommation.",
    ),
  ];
}

function freshnessRows(ledger: OverviewLedger, timeZone: string): FreshnessRowDto[] {
  if (ledger.state === "error") {
    return [{ source: "Registre des coûts", state: "error", lastCapturedAt: null, detail: LEDGER_ERROR }];
  }

  const rows: FreshnessRowDto[] = ledger.sources
    .map((source) => ({
      source: sourceLabel(source),
      state: "ok" as const,
      lastCapturedAt: formatInstant(source.sourceCapturedAt, { timeZone }),
      detail: null,
    }))
    .sort((a, b) => a.source.localeCompare(b.source));

  // No provider has an adapter yet: say so rather than leave the table silently short.
  if (!ledger.sources.some((source) => source.sourceKind === "PROVIDER")) {
    rows.push({
      source: "Fournisseurs IA (API)",
      state: "not-connected",
      lastCapturedAt: null,
      detail: "Aucune synchronisation de fournisseur n'est configurée.",
    });
  }

  if (ledger.sources.length === 0) {
    rows.unshift({
      source: "Registre des coûts",
      state: "no-data",
      lastCapturedAt: null,
      detail: "Aucune entrée de coût n'a encore été enregistrée.",
    });
  }

  return rows;
}

export function buildAiCostOverview(
  ledger: OverviewLedger,
  cycle: BillingCycle,
  timeZone: string,
  budgets: readonly OverviewBudget[] = [],
): AiCostOverviewDto {
  return {
    cycleLabel: cyclePeriod(cycle),
    kpis: [
      spendKpi(ledger, cycle),
      cycleProgressKpi(cycle),
      budgetKpi(ledger, cycle, budgets),
      ...pendingKpis(cycle),
    ],
    spendRows: ledger.state === "ok" ? spendRows(ledger.entries) : [],
    freshness: freshnessRows(ledger, timeZone),
  };
}
