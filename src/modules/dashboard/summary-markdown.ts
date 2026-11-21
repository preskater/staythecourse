import Decimal from "decimal.js";
import { formatMonthLabel, parseMonthKey, toDateOnlyString } from "@/lib/dates";
import { markdownTable } from "@/lib/markdown";
import { ACCOUNT_TYPE_LABELS, type CategoryKind } from "@/modules/budget/domain";
import { GOAL_STATUS_LABELS } from "@/modules/budget/goals";
import {
  OCCURRENCE_STATUS_LABELS,
  RECURRENCE_FREQUENCY_LABELS,
  type ForecastType,
} from "@/modules/budget/recurrence";
import { BILLING_MODEL_LABELS, PROJECT_STATUS_LABELS } from "@/modules/micro-business/domain";
import { REVENUE_STATUS_LABELS } from "@/modules/micro-business/revenue";
import { PROPERTY_OCCUPANCY_LABELS } from "@/modules/real-estate/domain";
import type { CashflowKind } from "@/modules/real-estate/domain";
import type {
  SituationSummary,
  SummaryAlert,
  SummaryFinance,
  SummaryGoal,
  SummaryIntegration,
  SummaryMicroBusiness,
  SummaryRealEstate,
  SummarySectionKey,
} from "./summary";

/**
 * Renders the situation summary as one Markdown document.
 *
 * The shape is deliberate, because the reader may be an assistant rather than a person:
 * a metadata table first, a vocabulary section that states what every convention means,
 * a table of what is included or absent (and why), then one section per area. Every
 * figure is an exact decimal string with its currency in its own column, so no reading
 * requires guessing a locale; an unrecorded value is the word `inconnu`, never `0`.
 *
 * Pure on purpose: the same `SituationSummary` always renders the same bytes, which is
 * what the tests pin down (no database, no clock, no locale).
 */

const UNKNOWN = "inconnu";
const NOT_APPLICABLE = "—";

const FORECAST_TYPE_LABELS: Record<ForecastType, string> = {
  INCOME: "Recette",
  EXPENSE: "Dépense",
};

const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  INCOME: "Recette",
  EXPENSE: "Dépense",
};

const CASHFLOW_KIND_LABELS: Record<CashflowKind, string> = {
  INCOME: "Recette",
  EXPENSE: "Dépense",
};

const WORKSPACE_KIND_LABELS: Record<SituationSummary["workspace"]["kind"], string> = {
  PERSONAL: "personnel",
  FAMILY: "famille",
  COMPANY: "entreprise",
};

const SCOPE_LABELS: Record<SituationSummary["scope"], string> = {
  all: "complet — tous les modules actifs",
  finance: "finance personnelle — module budget uniquement",
};

const INTEGRATION_STATE_LABELS: Record<SummaryIntegration["state"], string> = {
  NOT_CONNECTED: "non connecté",
  CONNECTED: "connecté",
  NEVER_SYNCED: "jamais synchronisé",
  ERROR: "erreur de synchronisation",
};

/** Two decimals, dot separator, no grouping: a value, not a formatted display. */
function amount(value: Decimal | null): string {
  return value === null ? UNKNOWN : value.toFixed(2);
}

function hours(value: Decimal | null): string {
  return value === null ? UNKNOWN : value.toFixed(2);
}

function percent(value: Decimal | null): string {
  return value === null ? UNKNOWN : `${value.toFixed(1)} %`;
}

function day(value: Date | null): string {
  return value === null ? NOT_APPLICABLE : toDateOnlyString(value);
}

function instant(value: Date | null): string {
  return value === null ? NOT_APPLICABLE : value.toISOString();
}

function text(value: string | null): string {
  return value === null || value.trim() === "" ? NOT_APPLICABLE : value.trim();
}

/** "novembre 2026 (2026-11)": readable for a person, unambiguous for a program. */
function monthTitle(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey);

  return `${formatMonthLabel(year, month)} (${monthKey})`;
}

/** "3 comptes sans opération exclus du total" — the count that makes a total honest. */
function unknownAccountsNote(count: number): string {
  return count > 0
    ? ` (${count} compte${count > 1 ? "s" : ""} sans opération : solde inconnu, exclu du total)`
    : "";
}

/** Whether a section carries any value at all, so the document never fakes an empty area. */
function hasData(summary: SituationSummary, key: SummarySectionKey): boolean {
  const finance = summary.finance;
  const realEstate = summary.realEstate;
  const microBusiness = summary.microBusiness;

  switch (key) {
    case "accounts":
      return (finance?.accounts.length ?? 0) > 0;
    case "actuals":
      return (finance?.reference.actuals.length ?? 0) > 0;
    case "budgets":
      return (finance?.reference.budgets.lines.length ?? 0) > 0;
    case "series":
      return (finance?.series.length ?? 0) > 0;
    case "forecast":
      return (
        (finance?.reference.totals.length ?? 0) > 0 || (finance?.reference.pending.length ?? 0) > 0
      );
    case "salary":
      return (
        finance?.salary.months.some((month) => month.hourlyRate !== null || month.booked) ?? false
      );
    case "schedule":
      return (
        finance?.schedule.some((month) => month.totals.length > 0 || month.balances.length > 0) ??
        false
      );
    case "savings":
      return (finance?.savings.length ?? 0) > 0;
    case "goals":
      return (finance?.goals.length ?? 0) > 0;
    case "properties":
      return (realEstate?.properties.length ?? 0) > 0;
    case "loans":
      return (realEstate?.loans.length ?? 0) > 0;
    case "propertyDue":
      return (realEstate?.due.length ?? 0) > 0;
    case "projects":
      return (microBusiness?.projects.length ?? 0) > 0;
    case "invoices":
      return (microBusiness?.invoices.length ?? 0) > 0;
    case "integrations":
      return (summary.integrations?.length ?? 0) > 0;
    case "alerts":
      return summary.alerts.length > 0;
  }
}

/** The document header: identity, reference period, and the vocabulary an assistant needs. */
function renderHeader(summary: SituationSummary): string[] {
  const lastHorizon = summary.horizonKeys[summary.horizonKeys.length - 1];

  return [
    `# Synthèse de situation — ${summary.monthLabel}`,
    "",
    `Document généré automatiquement le ${summary.generatedAt.toISOString()} pour l'espace de travail « ${summary.workspace.name} ». L'application est un tableau de bord personnel : budget, immobilier, micro-entreprise, projets GitHub et GitLab. Ce document décrit les données enregistrées et les prévisions qui en découlent ; les opérations comme les séries récurrentes sont saisies à la main (aucune connexion bancaire), et il ne contient ni recommandation, ni donnée de marché, ni estimation extérieure.`,
    "",
    "## Métadonnées",
    "",
    markdownTable(
      ["Champ", "Valeur"],
      [
        ["Format", "synthèse de situation, version 1 (Markdown)"],
        ["Généré le (UTC)", summary.generatedAt.toISOString()],
        ["Espace de travail", `${summary.workspace.name} (${WORKSPACE_KIND_LABELS[summary.workspace.kind]})`],
        ["Mois de référence", `${summary.monthKey} — ${summary.monthLabel}`],
        [
          "Horizon",
          `${summary.horizon} mois après le mois de référence (${summary.horizonKeys[0]} → ${lastHorizon})`,
        ],
        ["Devise par défaut", summary.defaultCurrency],
        ["Fuseau horaire d'affichage", summary.timeZone],
        ["Périmètre", SCOPE_LABELS[summary.scope]],
        ["Modules actifs", summary.modules.length > 0 ? summary.modules.join(", ") : "aucun"],
      ],
    ),
    "",
    "## Comment lire ce document",
    "",
    "- **Montants** : décimaux exacts, deux décimales, point décimal, sans séparateur de milliers. La devise est toujours dans une colonne ou une mention dédiée.",
    "- **Aucune conversion** : deux devises ne sont jamais additionnées ni converties. Un total par devise vaut pour cette devise seule.",
    "- **Signes** : un montant signé suit son sens, une sortie est négative. Dans les tableaux de réalisé, « Dépenses », « Charges » et « Reste dû » sont des magnitudes positives, et le net vaut recettes − dépenses.",
    "- **« inconnu »** : la valeur n'a jamais été enregistrée. Ce n'est pas zéro, et aucun calcul ne doit la remplacer par zéro.",
    "- **« — »** : valeur sans objet (par exemple une date de fin absente), à distinguer d'un inconnu.",
    "- **Dates** : les dates calendaires sont en `AAAA-MM-JJ` sans fuseau ; les instants sont en ISO 8601 UTC.",
    "- **Réalisé / prévu** : « réalisé » désigne les opérations enregistrées. « Prévu » désigne les séries récurrentes et le salaire simulé, qui ne sont pas enregistrés : un mouvement prévu ne compte dans aucun total réel avant sa confirmation.",
    "- **Transferts** : un transfert entre comptes compte dans les recettes ou les dépenses selon son signe ; son volume est un sous-total, jamais un montant à ajouter.",
    "- **Salaire simulé** : il n'est une recette qu'une fois enregistré. Tant qu'il reste une prévision, il ne figure pas dans le réalisé.",
    "- **Sections absentes** : un module inactif ou exclu du périmètre n'est pas lu du tout. Son absence n'est ni un zéro ni une donnée manquante.",
    "",
  ];
}

/** The inclusion table: what is in the document, what is not, and why. */
function renderSections(summary: SituationSummary): string[] {
  return [
    "## Sections du document",
    "",
    markdownTable(
      ["Section", "État"],
      summary.sections.map((section) => [
        section.title,
        !section.included
          ? `non incluse — ${section.reason ?? "raison non précisée"}`
          : !hasData(summary, section.key)
            ? "incluse — aucune donnée enregistrée"
            : "incluse",
      ]),
    ),
    "",
  ];
}

/** "Lecture tronquée" note, only for the sections that were actually cut. */
function truncationNote(summary: SituationSummary, key: SummarySectionKey): string[] {
  return summary.truncated.includes(key)
    ? ["> Lecture tronquée : seules les premières lignes de cette section sont présentes.", ""]
    : [];
}

function renderAccounts(finance: SummaryFinance): string[] {
  return [
    "## Comptes",
    "",
    finance.accounts.length === 0
      ? "Aucun compte enregistré."
      : markdownTable(
          ["Compte", "Type", "Devise", "Solde enregistré", "Dernière opération"],
          finance.accounts.map((account) => [
            account.name,
            ACCOUNT_TYPE_LABELS[account.type],
            account.currency,
            amount(account.balance),
            day(account.lastOperationOn),
          ]),
        ),
    "",
    ...finance.accountTotals.map((total) =>
      total.knownAccounts === 0
        ? `- Total enregistré en ${total.currency} : ${UNKNOWN}${unknownAccountsNote(total.unknownAccounts)}.`
        : `- Total enregistré en ${total.currency} : ${total.balance.toFixed(2)} ${total.currency}${unknownAccountsNote(total.unknownAccounts)}.`,
    ),
    ...(finance.accountTotals.length > 0 ? [""] : []),
  ];
}

function renderActuals(finance: SummaryFinance): string[] {
  const actuals = finance.reference.actuals;

  return [
    `## Réalisé — ${monthTitle(finance.reference.monthKey)}`,
    "",
    actuals.length === 0
      ? "Aucune opération enregistrée pour ce mois. Un mois vide n'est pas un mois à zéro : rien n'a été saisi."
      : markdownTable(
          ["Devise", "Recettes", "Dépenses", "Transferts", "Net", "Opérations"],
          actuals.map((row) => [
            row.currency,
            row.income.toFixed(2),
            row.expenses.toFixed(2),
            row.transfers.toFixed(2),
            row.net.toFixed(2),
            row.transactionCount,
          ]),
        ),
    "",
  ];
}

function renderBudgets(finance: SummaryFinance): string[] {
  const { lines, totals } = finance.reference.budgets;
  const lines_out =
    lines.length === 0
      ? ["Aucun budget défini pour ce mois."]
      : [
          markdownTable(
            ["Catégorie", "Nature", "Devise", "Prévu", "Réalisé", "Reste"],
            lines.map((line) => [
              line.categoryName,
              CATEGORY_KIND_LABELS[line.categoryKind],
              line.currency,
              line.planned.toFixed(2),
              line.actual.toFixed(2),
              line.remaining.toFixed(2),
            ]),
          ),
        ];

  return [
    `## Budgets et suivi — ${monthTitle(finance.reference.monthKey)}`,
    "",
    ...lines_out,
    "",
    ...totals.map(
      (total) =>
        `- ${CATEGORY_KIND_LABELS[total.categoryKind]} en ${total.currency} : prévu ${total.planned.toFixed(2)}, réalisé ${total.actual.toFixed(2)}, reste ${total.remaining.toFixed(2)}.`,
    ),
    ...(totals.length > 0 ? [""] : []),
  ];
}

function renderSeries(finance: SummaryFinance): string[] {
  return [
    "## Séries récurrentes",
    "",
    finance.series.length === 0
      ? "Aucune série récurrente. Sans série, aucune prévision n'est produite et le seuil d'épargne ne peut pas être calculé."
      : markdownTable(
          [
            "Libellé",
            "Nature",
            "Montant planifié",
            "Devise",
            "Cadence",
            "Compte",
            "Catégorie",
            "Début",
            "Fin",
          ],
          finance.series.map((entry) => [
            entry.label,
            FORECAST_TYPE_LABELS[entry.type],
            entry.amount.toFixed(2),
            entry.currency,
            RECURRENCE_FREQUENCY_LABELS[entry.frequency],
            entry.accountName,
            text(entry.categoryName),
            day(entry.startDate),
            entry.endDate === null ? "sans fin" : day(entry.endDate),
          ]),
        ),
    "",
    "Le montant planifié est toujours positif : c'est la nature (recette ou dépense) qui donne le sens.",
    "",
  ];
}

function renderForecast(finance: SummaryFinance): string[] {
  const { totals, pending } = finance.reference;

  return [
    `## Prévisions — ${monthTitle(finance.reference.monthKey)}`,
    "",
    totals.length === 0
      ? "Aucun mouvement prévu pour ce mois : ni série récurrente, ni salaire simulé."
      : markdownTable(
          ["Devise", "Recettes prévues", "Dépenses prévues", "Net prévu", "Mouvements", "Dont confirmés"],
          totals.map((total) => [
            total.currency,
            total.income.toFixed(2),
            total.expenses.toFixed(2),
            total.net.toFixed(2),
            total.count,
            total.confirmedCount,
          ]),
        ),
    "",
    "Ces totaux sont des prévisions, confirmées comprises : un mouvement confirmé est devenu une opération et compte aussi dans le réalisé.",
    "",
    pending.length === 0
      ? "Aucun mouvement en attente de décision pour ce mois."
      : markdownTable(
          ["Date", "Libellé", "Nature", "Montant signé", "Devise", "Source", "Statut"],
          pending.map((movement) => [
            day(movement.date),
            movement.label,
            FORECAST_TYPE_LABELS[movement.type],
            movement.amount.toFixed(2),
            movement.currency,
            movement.source === "SALARY" ? "salaire simulé" : "série récurrente",
            OCCURRENCE_STATUS_LABELS[movement.status],
          ]),
        ),
    "",
  ];
}

function renderSalary(finance: SummaryFinance): string[] {
  const { salary } = finance;

  return [
    "## Salaire simulé et enregistré",
    "",
    salary.currency === null
      ? "Aucun réglage de salaire enregistré : la simulation n'est pas disponible, ce qui n'est pas un salaire nul."
      : `Devise du salaire : ${salary.currency}. Journée type : ${hours(salary.hoursPerDay)} h. Le taux horaire est un point de changement : il s'applique à partir du mois où il est enregistré, jusqu'au suivant.`,
    salary.equivalents === null
      ? ""
      : `Équivalents indicatifs au taux du mois de référence : ${amount(salary.equivalents.daily)} par jour, ${amount(salary.equivalents.weekly)} par semaine (5 jours), ${amount(salary.equivalents.monthly)} par mois (52/12). Ce sont des conversions d'affichage, pas un bulletin de paie ni une recette enregistrée.`,
    "",
    salary.months.length === 0
      ? ""
      : markdownTable(
          [
            "Mois",
            "Taux horaire",
            "Heures prévues",
            "Heures travaillées",
            "Total heures",
            "Montant simulé",
            "Enregistré",
          ],
          salary.months.map((month) => [
            month.monthKey,
            amount(month.hourlyRate),
            month.hasCalendar ? hours(month.plannedHours) : NOT_APPLICABLE,
            month.hasCalendar ? hours(month.workedHours) : NOT_APPLICABLE,
            month.hasCalendar ? hours(month.totalHours) : NOT_APPLICABLE,
            month.hasCalendar ? amount(month.simulatedAmount) : NOT_APPLICABLE,
            month.booked
              ? `oui — ${amount(month.bookedAmount)} ${month.currency ?? ""}`.trim()
              : "non",
          ]),
        ),
    "",
    "« Enregistré » signifie qu'une opération de salaire existe pour ce mois : c'est elle qui compte dans le réalisé, pas le calendrier simulé.",
    "",
  ];
}

function renderSchedule(finance: SummaryFinance): string[] {
  const rows: unknown[][] = [];
  const emptyMonths: string[] = [];

  for (const month of finance.schedule) {
    if (month.totals.length === 0 && month.balances.length === 0) {
      emptyMonths.push(month.monthKey);
      continue;
    }

    const currencies = [
      ...new Set([
        ...month.totals.map((total) => total.currency),
        ...month.balances.map((entry) => entry.currency),
      ]),
    ].sort();

    for (const currency of currencies) {
      const total = month.totals.find((entry) => entry.currency === currency);
      const balance = month.balances.find((entry) => entry.currency === currency);

      rows.push([
        month.monthKey,
        currency,
        total ? total.income.toFixed(2) : UNKNOWN,
        total ? total.expenses.toFixed(2) : UNKNOWN,
        total ? total.net.toFixed(2) : UNKNOWN,
        balance ? balance.balance.toFixed(2) : UNKNOWN,
        total ? total.count : 0,
      ]);
    }
  }

  return [
    "## Échéancier des mois à venir",
    "",
    `Prévisions des mois qui suivent le mois de référence (${finance.schedule.length} mois : de ${finance.schedule[0]?.monthKey ?? "—"} à ${finance.schedule[finance.schedule.length - 1]?.monthKey ?? "—"}), séries récurrentes et salaire simulé compris. Le solde simulé de fin de mois part du cumul enregistré avant la fenêtre, puis avance avec les opérations enregistrées et les mouvements en attente de chaque mois ; il n'inclut pas les échéances déjà décidées, qui sont devenues des opérations. Une devise sans aucune opération enregistrée n'a pas de solde simulé : la cellule vaut « inconnu ».`,
    "",
    rows.length === 0
      ? "Aucun mouvement prévu ni solde enregistré sur ces mois."
      : markdownTable(
          [
            "Mois",
            "Devise",
            "Recettes prévues",
            "Dépenses prévues",
            "Net prévu",
            "Solde simulé fin de mois",
            "Mouvements",
          ],
          rows,
        ),
    "",
    emptyMonths.length === 0
      ? ""
      : `Mois sans aucune donnée (ni prévision, ni solde enregistré) : ${emptyMonths.join(", ")}.`,
    ...(emptyMonths.length === 0 ? [] : [""]),
  ];
}

function renderSavings(finance: SummaryFinance): string[] {
  return [
    "## Épargne de précaution",
    "",
    finance.savings.length === 0
      ? "Aucune dépense prévue par une série récurrente sur les six mois du mois de référence : le seuil ne peut pas être calculé, ce qui n'est pas un seuil à zéro."
      : markdownTable(
          [
            "Devise",
            "Seuil conseillé (6 mois de dépenses prévues)",
            "Solde d'épargne",
            "Manque",
            "Autonomie (mois)",
            "Comptes d'épargne",
          ],
          finance.savings.map((threshold) => [
            threshold.currency,
            threshold.expectedTotal.toFixed(2),
            amount(threshold.savingsBalance),
            amount(threshold.shortfall),
            amount(threshold.runwayMonths),
            `${threshold.recordedAccountCount}/${threshold.savingsAccountCount} renseignés`,
          ]),
        ),
    "",
    "Le seuil conseillé est six mois de dépenses prévues, mois de référence compris, calculé à partir des séries récurrentes. Un compte d'épargne sans opération enregistrée reste inconnu, jamais zéro. Le manque est négatif quand le coussin est dépassé.",
    "",
  ];
}

function renderGoals(goals: SummaryGoal[]): string[] {
  return [
    "## Objectifs",
    "",
    goals.length === 0
      ? "Aucun objectif enregistré."
      : markdownTable(
          [
            "Nom",
            "Devise",
            "Cible",
            "Échéance",
            "Statut",
            "Montant actuel",
            "Progression",
            "Reste",
            "Contribution mensuelle",
            "Note",
          ],
          goals.map((goal) => [
            goal.name,
            goal.currency,
            goal.targetAmount.toFixed(2),
            day(goal.targetDate),
            GOAL_STATUS_LABELS[goal.status],
            goal.progress.kind === "KNOWN" ? goal.progress.current.toFixed(2) : UNKNOWN,
            goal.progress.kind === "KNOWN" ? percent(goal.progress.percentage) : UNKNOWN,
            goal.progress.kind === "KNOWN" ? goal.progress.remaining.toFixed(2) : UNKNOWN,
            goal.progress.kind === "KNOWN"
              ? amount(goal.progress.monthlyContribution)
              : UNKNOWN,
            goal.progress.kind === "KNOWN"
              ? text(goal.progress.contributionNote)
              : goal.progress.reason,
          ]),
        ),
    "",
    "Un objectif sans montant actuel ni compte lié, ou lié à un compte sans opération, a une progression inconnue : ce n'est pas une progression à zéro pour cent.",
    "",
  ];
}

function renderProperties(realEstate: SummaryRealEstate): string[] {
  const withNotes = realEstate.properties.some((property) => property.notes !== null);
  const headers = [
    "Bien",
    "Occupation",
    "Acquisition",
    "Prix d'acquisition",
    "Devise",
    "Valeur estimée",
    "Valeur estimée au",
    "Recettes",
    "Charges",
    "Net",
    "Flux enregistrés",
    ...(withNotes ? ["Notes"] : []),
  ];

  return [
    "## Biens immobiliers",
    "",
    realEstate.properties.length === 0
      ? "Aucun bien enregistré."
      : markdownTable(
          headers,
          realEstate.properties.map((property) => [
            property.name,
            PROPERTY_OCCUPANCY_LABELS[property.occupancy],
            day(property.purchaseDate),
            amount(property.purchasePrice),
            property.currency,
            amount(property.estimatedValue),
            day(property.estimatedValueAsOf),
            property.income.toFixed(2),
            property.expenses.toFixed(2),
            property.net.toFixed(2),
            property.cashflowCount,
            ...(withNotes ? [text(property.notes)] : []),
          ]),
        ),
    "",
    "Les recettes et charges d'un bien proviennent de ses flux enregistrés. Un bien n'est pas forcément loué : sans flux, les totaux valent zéro et la colonne « Flux enregistrés » dit qu'aucune donnée n'existe.",
    ...realEstate.properties
      .filter((property) => property.foreignCurrencyCashflows > 0)
      .map(
        (property) =>
          `- ${property.name} : ${property.foreignCurrencyCashflows} flux dans une autre devise sont exclus des totaux ci-dessus, faute de conversion.`,
      ),
    "",
  ];
}

function renderLoans(realEstate: SummaryRealEstate): string[] {
  return [
    "## Crédits immobiliers",
    "",
    realEstate.loans.length === 0
      ? "Aucun crédit enregistré."
      : markdownTable(
          [
            "Bien",
            "Libellé",
            "Devise",
            "Capital initial",
            "Solde restant",
            "Taux annuel",
            "Mensualité",
            "Assurance",
            "Fin",
          ],
          realEstate.loans.map((loan) => [
            loan.propertyName,
            loan.label,
            loan.currency,
            loan.initialPrincipal.toFixed(2),
            amount(loan.outstandingBalance),
            loan.interestRate === null ? UNKNOWN : `${loan.interestRate.toFixed(2)} %`,
            amount(loan.paymentAmount),
            amount(loan.insuranceAmount),
            day(loan.endDate),
          ]),
        ),
    "",
  ];
}

function renderPropertyDue(
  realEstate: SummaryRealEstate,
  today: Date,
): string[] {
  const todayKey = toDateOnlyString(today);

  return [
    "## Échéances immobilières non réglées",
    "",
    realEstate.due.length === 0
      ? "Aucune échéance immobilière non réglée sur l'horizon."
      : markdownTable(
          ["Bien", "Libellé", "Nature", "Montant", "Devise", "Échéance", "État"],
          realEstate.due.map((entry) => [
            entry.propertyName,
            entry.label,
            CASHFLOW_KIND_LABELS[entry.kind],
            amount(entry.amount),
            entry.currency,
            day(entry.dueDate),
            entry.dueDate !== null && toDateOnlyString(entry.dueDate) < todayKey
              ? "en retard"
              : "à venir",
          ]),
        ),
    "",
  ];
}

function renderProjects(microBusiness: SummaryMicroBusiness): string[] {
  return [
    "## Projets de la micro-entreprise",
    "",
    microBusiness.projects.length === 0
      ? "Aucun projet enregistré."
      : markdownTable(
          ["Nom", "Client", "Facturation", "Statut", "Devise", "Début", "Fin"],
          microBusiness.projects.map((project) => [
            project.name,
            text(project.clientName),
            BILLING_MODEL_LABELS[project.billingModel],
            PROJECT_STATUS_LABELS[project.status],
            project.currency,
            day(project.startDate),
            day(project.endDate),
          ]),
        ),
    "",
  ];
}

function renderInvoices(microBusiness: SummaryMicroBusiness): string[] {
  return [
    "## Facturation de la micro-entreprise",
    "",
    microBusiness.invoices.length === 0
      ? "Aucune facture avec un reste dû : rien à encaisser."
      : markdownTable(
          [
            "Client",
            "Projet",
            "Devise",
            "Facturé",
            "Avoirs",
            "Net",
            "Encaissé",
            "Reste dû",
            "Émise le",
            "Échéance",
            "Statut",
            "Retard (jours)",
          ],
          microBusiness.invoices.map((invoice) => [
            text(invoice.clientName),
            invoice.projectName,
            invoice.currency,
            invoice.amount.toFixed(2),
            invoice.amount.minus(invoice.netIssued).toFixed(2),
            invoice.netIssued.toFixed(2),
            invoice.paid.toFixed(2),
            invoice.outstanding.toFixed(2),
            day(invoice.issuedOn),
            day(invoice.dueOn),
            REVENUE_STATUS_LABELS[invoice.status],
            invoice.overdueDays,
          ]),
        ),
    "",
    ...microBusiness.outstandingTotals.map(
      (total) => `- Reste à encaisser en ${total.currency} : ${total.amount.toFixed(2)} ${total.currency}.`,
    ),
    ...(microBusiness.outstandingTotals.length > 0 ? [""] : []),
    "Le reste dû est une créance, pas une recette : aucune de ces factures n'est encore une opération enregistrée.",
    "",
  ];
}

function renderIntegrations(integrations: SummaryIntegration[]): string[] {
  return [
    "## Intégrations",
    "",
    integrations.length === 0
      ? "Aucune intégration configurée."
      : markdownTable(
          [
            "Fournisseur",
            "Instance",
            "État",
            "Dernière synchronisation",
            "Projets suivis",
            "Issues et pull requests",
            "Jalons",
          ],
          integrations.map((integration) => [
            integration.provider,
            integration.instance,
            INTEGRATION_STATE_LABELS[integration.state],
            instant(integration.lastSyncedAt),
            integration.projectCount,
            integration.issueCount,
            integration.milestoneCount,
          ]),
        ),
    "",
    "Un état « jamais synchronisé » ou « erreur de synchronisation » signifie que les chiffres du fournisseur sont absents, pas nuls. Aucun jeton n'est présent dans ce document.",
    "",
  ];
}

function renderAlerts(alerts: SummaryAlert[]): string[] {
  return [
    "## Alertes actives",
    "",
    alerts.length === 0
      ? "Aucune alerte active."
      : markdownTable(
          ["Règle", "Déclenchée le", "Raison"],
          alerts.map((alert) => [
            alert.title,
            instant(alert.triggeredAt),
            alert.reason,
          ]),
        ),
    "",
  ];
}

/** Renders the whole document. Deterministic: same input, same bytes. */
export function renderSituationSummary(summary: SituationSummary): string {
  const lines: string[] = [
    ...renderHeader(summary),
    ...renderSections(summary),
  ];

  const finance = summary.finance;

  if (finance) {
    const included = new Set(
      summary.sections.filter((section) => section.included).map((section) => section.key),
    );

    if (included.has("accounts")) {
      lines.push(...renderAccounts(finance), ...truncationNote(summary, "accounts"));
    }

    if (included.has("actuals")) {
      lines.push(...renderActuals(finance), ...truncationNote(summary, "actuals"));
    }

    if (included.has("budgets")) {
      lines.push(...renderBudgets(finance), ...truncationNote(summary, "budgets"));
    }

    if (included.has("series")) {
      lines.push(...renderSeries(finance), ...truncationNote(summary, "series"));
    }

    if (included.has("forecast")) {
      lines.push(...renderForecast(finance), ...truncationNote(summary, "forecast"));
    }

    if (included.has("salary")) {
      lines.push(...renderSalary(finance));
    }

    if (included.has("schedule")) {
      lines.push(...renderSchedule(finance), ...truncationNote(summary, "schedule"));
    }

    if (included.has("savings")) {
      lines.push(...renderSavings(finance));
    }

    if (included.has("goals")) {
      lines.push(...renderGoals(finance.goals), ...truncationNote(summary, "goals"));
    }
  }

  if (summary.realEstate) {
    const included = new Set(
      summary.sections.filter((section) => section.included).map((section) => section.key),
    );

    if (included.has("properties")) {
      lines.push(
        ...renderProperties(summary.realEstate),
        ...truncationNote(summary, "properties"),
      );
    }

    if (included.has("loans")) {
      lines.push(...renderLoans(summary.realEstate), ...truncationNote(summary, "loans"));
    }

    if (included.has("propertyDue")) {
      lines.push(
        ...renderPropertyDue(summary.realEstate, summary.generatedAt),
        ...truncationNote(summary, "propertyDue"),
      );
    }
  }

  if (summary.microBusiness) {
    const included = new Set(
      summary.sections.filter((section) => section.included).map((section) => section.key),
    );

    if (included.has("projects")) {
      lines.push(
        ...renderProjects(summary.microBusiness),
        ...truncationNote(summary, "projects"),
      );
    }

    if (included.has("invoices")) {
      lines.push(
        ...renderInvoices(summary.microBusiness),
        ...truncationNote(summary, "invoices"),
      );
    }
  }

  if (summary.integrations) {
    lines.push(...renderIntegrations(summary.integrations), ...truncationNote(summary, "integrations"));
  }

  lines.push(...renderAlerts(summary.alerts), ...truncationNote(summary, "alerts"));

  // One final newline keeps the file a well-formed Markdown document.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
