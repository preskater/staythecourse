import Decimal from "decimal.js";
import { z } from "zod";
import {
  formatDateOnly,
  formatInstant,
  formatMonthLabel,
  parseDateOnly,
  parseMonthKey,
} from "@/lib/dates";
import {
  assertCurrency,
  DEFAULT_CURRENCY,
  formatMoney,
  type Currency,
} from "@/lib/money";
import type { ModuleKey } from "@/modules/catalog/catalog";

/**
 * Alert engine — shared contract (BP-05).
 *
 * An alert is an **observation** about data the owner already has: no rule ever writes
 * to the ledger, and a rule that cannot read its data stays silent instead of guessing.
 * Only deterministic rules run here; statistical heuristics are explicitly out of scope
 * for this first pass.
 *
 * What is stored is not the sentence but its inputs (`inputs`, strings only: amounts,
 * names, dates, computed gaps). The French reason displayed on screen is recomputed from
 * those inputs by `describeAlert`, so a forged request can never write the text a page
 * shows — and a wording change never needs a migration.
 *
 * Duplicates are suppressed by the `fingerprint`: rule + entity + period, unique per
 * owner. A dismissed alert stays dismissed while the condition holds; once the condition
 * resolves, a later re-trigger opens a new episode (`triggeredAt` resets).
 */

/** The watched situations. Kept in sync with the `AlertKind` enum in the schema. */
export const ALERT_KINDS = [
  "LOW_BALANCE",
  "BUDGET_OVERRUN",
  "BUDGET_THRESHOLD",
  "UNUSUAL_EXPENSE",
  "STALE_INTEGRATION",
  "OVERDUE_EVENT",
  "AI_BUDGET_OVERRUN",
  "AI_BUDGET_THRESHOLD",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * The module whose data each rule reads. An alert of an inactive module is not shown nor
 * exported: its stored episode stays as it is and reappears once the module is back.
 */
export const ALERT_KIND_MODULES: Record<AlertKind, ModuleKey> = {
  LOW_BALANCE: "budget",
  BUDGET_OVERRUN: "budget",
  BUDGET_THRESHOLD: "budget",
  UNUSUAL_EXPENSE: "budget",
  STALE_INTEGRATION: "development",
  OVERDUE_EVENT: "real-estate",
  AI_BUDGET_OVERRUN: "ai-costs",
  AI_BUDGET_THRESHOLD: "ai-costs",
};

export function isAlertVisible(kind: AlertKind, modules: readonly ModuleKey[]): boolean {
  return modules.includes(ALERT_KIND_MODULES[kind]);
}

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  LOW_BALANCE: "Solde bas",
  BUDGET_OVERRUN: "Dépassement de budget",
  BUDGET_THRESHOLD: "Seuil de budget atteint",
  UNUSUAL_EXPENSE: "Dépense au-dessus du seuil",
  STALE_INTEGRATION: "Synchronisation ancienne",
  OVERDUE_EVENT: "Échéance dépassée",
  AI_BUDGET_OVERRUN: "Dépassement de budget IA",
  AI_BUDGET_THRESHOLD: "Seuil de budget IA atteint",
};

/** The lifecycle. Kept in sync with the `AlertStatus` enum in the schema. */
export const ALERT_STATUSES = ["ACTIVE", "DISMISSED", "RESOLVED"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  ACTIVE: "Active",
  DISMISSED: "Écartée",
  RESOLVED: "Résolue",
};

/** Message inputs as stored: plain strings and nulls, never free text to display as-is. */
export type AlertInputs = Record<string, string | null>;

/** One condition an evaluation found true, before it meets the stored rows. */
export type AlertCandidate = {
  kind: AlertKind;
  /** Rule + entity + period: the identity that keeps duplicates out. */
  fingerprint: string;
  inputs: AlertInputs;
};

/*
 * Fingerprints. The entity identifies *what* is watched, the period bounds the episode:
 * an overrun is re-asked every month, a low balance is re-asked whenever it happens.
 */

export function lowBalanceFingerprint(accountId: string): string {
  return `low-balance:${accountId}`;
}

export function budgetOverrunFingerprint(
  categoryId: string,
  currency: Currency,
  monthKey: string,
): string {
  return `budget-overrun:${categoryId}:${currency}:${monthKey}`;
}

/**
 * The threshold rule is complementary to the overrun one, never a duplicate: it fires
 * while the budget is **not** exceeded yet (see `evaluateBudgetThreshold`), so an
 * episode resolves the moment the overrun one opens.
 */
export function budgetThresholdFingerprint(
  categoryId: string,
  currency: Currency,
  monthKey: string,
): string {
  return `budget-threshold:${categoryId}:${currency}:${monthKey}`;
}

export function unusualExpenseFingerprint(transactionId: string): string {
  return `unusual-expense:${transactionId}`;
}

export function staleIntegrationFingerprint(connectionId: string): string {
  return `stale-integration:${connectionId}`;
}

export function overdueEventFingerprint(cashflowId: string): string {
  return `overdue-event:${cashflowId}`;
}

/*
 * Reason rendering, from the stored inputs only.
 */

export type AlertTone = "warning" | "negative";

export type DescribedAlert = {
  title: string;
  reason: string;
  tone: AlertTone;
};

/** Pluralised French day count: "1 jour", "3 jours". */
function daysLabel(count: string): string {
  return count === "1" ? "1 jour" : `${count} jours`;
}

function decimalString(value: string): Decimal | null {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function money(value: string, currency: string): string | null {
  const parsed = decimalString(value);

  try {
    return parsed === null ? null : formatMoney({ amount: parsed, currency: assertCurrency(currency) });
  } catch {
    return null;
  }
}

/** "6.7" → "6,7" — display only; the stored figure keeps its exact value. */
function frenchNumber(value: string, maximumFractionDigits = 1): string {
  const parsed = decimalString(value);
  if (parsed === null) {
    return value;
  }

  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits }).format(parsed.toNumber());
}

const LOW_BALANCE_INPUTS = z.object({
  accountName: z.string(),
  currency: z.string(),
  balance: z.string(),
  threshold: z.string(),
});

function describeLowBalance(inputs: z.infer<typeof LOW_BALANCE_INPUTS>): DescribedAlert {
  const balance = money(inputs.balance, inputs.currency);
  const threshold = money(inputs.threshold, inputs.currency);

  if (balance === null || threshold === null) {
    return unreadable("Solde bas");
  }

  const isNegative = (decimalString(inputs.balance) ?? new Decimal(0)).lessThan(0);

  return {
    title: ALERT_KIND_LABELS.LOW_BALANCE,
    reason: isNegative
      ? `Le solde de « ${inputs.accountName} » est négatif : ${balance}.`
      : `Le solde de « ${inputs.accountName} » est de ${balance}, sous le seuil configuré de ${threshold}.`,
    tone: isNegative ? "negative" : "warning",
  };
}

const BUDGET_OVERRUN_INPUTS = z.object({
  categoryName: z.string(),
  currency: z.string(),
  month: z.string(),
  planned: z.string(),
  actual: z.string(),
  overrun: z.string(),
  overrunPercent: z.string(),
});

function describeBudgetOverrun(inputs: z.infer<typeof BUDGET_OVERRUN_INPUTS>): DescribedAlert {
  const planned = money(inputs.planned, inputs.currency);
  const actual = money(inputs.actual, inputs.currency);
  const overrun = money(inputs.overrun, inputs.currency);

  if (planned === null || actual === null || overrun === null) {
    return unreadable(ALERT_KIND_LABELS.BUDGET_OVERRUN);
  }

  let monthLabel = inputs.month;
  try {
    const { year, month } = parseMonthKey(inputs.month);
    monthLabel = formatMonthLabel(year, month);
  } catch {
    // Keep the raw key: a label is display, never a reason to crash.
  }

  return {
    title: ALERT_KIND_LABELS.BUDGET_OVERRUN,
    reason: `Budget « ${inputs.categoryName} » (${inputs.currency}, ${monthLabel}) : ${actual} réalisés pour ${planned} planifiés, soit un dépassement de ${overrun} (${frenchNumber(inputs.overrunPercent)} %).`,
    tone: "negative",
  };
}

const BUDGET_THRESHOLD_INPUTS = z.object({
  categoryName: z.string(),
  currency: z.string(),
  month: z.string(),
  planned: z.string(),
  actual: z.string(),
  percent: z.string(),
  thresholdPercent: z.string(),
});

function describeBudgetThreshold(inputs: z.infer<typeof BUDGET_THRESHOLD_INPUTS>): DescribedAlert {
  const planned = money(inputs.planned, inputs.currency);
  const actual = money(inputs.actual, inputs.currency);

  if (planned === null || actual === null) {
    return unreadable(ALERT_KIND_LABELS.BUDGET_THRESHOLD);
  }

  let monthLabel = inputs.month;
  try {
    const { year, month } = parseMonthKey(inputs.month);
    monthLabel = formatMonthLabel(year, month);
  } catch {
    // Keep the raw key: a label is display, never a reason to crash.
  }

  return {
    title: ALERT_KIND_LABELS.BUDGET_THRESHOLD,
    reason: `Budget « ${inputs.categoryName} » (${inputs.currency}, ${monthLabel}) : ${actual} réalisés pour ${planned} planifiés, soit ${frenchNumber(inputs.percent)} % du budget — le seuil d'alerte de ${frenchNumber(inputs.thresholdPercent)} % est atteint, sans dépassement pour l'instant.`,
    tone: "warning",
  };
}

const UNUSUAL_EXPENSE_INPUTS = z.object({
  label: z.string(),
  amount: z.string(),
  currency: z.string(),
  date: z.string(),
  threshold: z.string(),
});

function describeUnusualExpense(inputs: z.infer<typeof UNUSUAL_EXPENSE_INPUTS>): DescribedAlert {
  const amount = money(inputs.amount, inputs.currency);
  const threshold = money(inputs.threshold, inputs.currency);

  if (amount === null || threshold === null) {
    return unreadable(ALERT_KIND_LABELS.UNUSUAL_EXPENSE);
  }

  let dateLabel = inputs.date;
  try {
    dateLabel = formatDateOnly(parseDateOnly(inputs.date));
  } catch {
    // Same rule: a malformed date is display noise, not a crash.
  }

  return {
    title: ALERT_KIND_LABELS.UNUSUAL_EXPENSE,
    reason: `Dépense « ${inputs.label} » de ${amount} le ${dateLabel} : au niveau ou au-dessus du seuil de ${threshold}.`,
    tone: "warning",
  };
}

const STALE_INTEGRATION_INPUTS = z.object({
  provider: z.string(),
  instance: z.string(),
  lastSyncedAt: z.string(),
  daysSince: z.string(),
  thresholdDays: z.string(),
});

function describeStaleIntegration(inputs: z.infer<typeof STALE_INTEGRATION_INPUTS>): DescribedAlert {
  const providerLabel = inputs.provider === "GITHUB" ? "GitHub" : inputs.provider === "GITLAB" ? "GitLab" : inputs.provider;
  const lastSynced = new Date(inputs.lastSyncedAt);
  const lastSyncedLabel = Number.isNaN(lastSynced.getTime())
    ? inputs.lastSyncedAt
    : formatInstant(lastSynced);

  return {
    title: ALERT_KIND_LABELS.STALE_INTEGRATION,
    reason: `${providerLabel} (${inputs.instance}) : dernière synchronisation réussie le ${lastSyncedLabel}, il y a ${daysLabel(inputs.daysSince)} (seuil : ${daysLabel(inputs.thresholdDays)}).`,
    tone: "warning",
  };
}

const OVERDUE_EVENT_INPUTS = z.object({
  propertyName: z.string(),
  label: z.string(),
  currency: z.string(),
  amount: z.string().nullable(),
  dueDate: z.string(),
  daysLate: z.string(),
  thresholdDays: z.string(),
});

function describeOverdueEvent(inputs: z.infer<typeof OVERDUE_EVENT_INPUTS>): DescribedAlert {
  let dueDateLabel = inputs.dueDate;
  try {
    dueDateLabel = formatDateOnly(parseDateOnly(inputs.dueDate));
  } catch {
    // Display-only fallback, as above.
  }

  const amount =
    inputs.amount === null
      ? "montant inconnu"
      : (money(inputs.amount, inputs.currency) ?? "montant inconnu");

  const grace =
    inputs.thresholdDays === "0"
      ? ""
      : ` (grâce de ${daysLabel(inputs.thresholdDays)} appliquée)`;

  return {
    title: ALERT_KIND_LABELS.OVERDUE_EVENT,
    reason: `« ${inputs.label} » (${inputs.propertyName}) : échéance du ${dueDateLabel}, dépassée de ${daysLabel(inputs.daysLate)}${grace} — ${amount} non réglé.`,
    tone: "warning",
  };
}

const AI_BUDGET_INPUTS = z.object({
  scope: z.string(),
  currency: z.string(),
  month: z.string(),
  planned: z.string(),
  actual: z.string(),
});

const AI_BUDGET_OVERRUN_INPUTS = AI_BUDGET_INPUTS.extend({
  overrun: z.string(),
  overrunPercent: z.string(),
});

const AI_BUDGET_THRESHOLD_INPUTS = AI_BUDGET_INPUTS.extend({
  percent: z.string(),
  thresholdPercent: z.string(),
});

function monthLabelOf(monthKey: string): string {
  try {
    const { year, month } = parseMonthKey(monthKey);
    return formatMonthLabel(year, month);
  } catch {
    return monthKey;
  }
}

function describeAiBudgetOverrun(inputs: z.infer<typeof AI_BUDGET_OVERRUN_INPUTS>): DescribedAlert {
  const planned = money(inputs.planned, inputs.currency);
  const actual = money(inputs.actual, inputs.currency);
  const overrun = money(inputs.overrun, inputs.currency);

  if (planned === null || actual === null || overrun === null) {
    return unreadable(ALERT_KIND_LABELS.AI_BUDGET_OVERRUN);
  }

  return {
    title: ALERT_KIND_LABELS.AI_BUDGET_OVERRUN,
    reason: `Budget IA ${inputs.scope} (${inputs.currency}, ${monthLabelOf(inputs.month)}) : ${actual} dépensés pour ${planned} prévus, soit un dépassement de ${overrun} (${frenchNumber(inputs.overrunPercent)} %).`,
    tone: "negative",
  };
}

function describeAiBudgetThreshold(inputs: z.infer<typeof AI_BUDGET_THRESHOLD_INPUTS>): DescribedAlert {
  const planned = money(inputs.planned, inputs.currency);
  const actual = money(inputs.actual, inputs.currency);

  if (planned === null || actual === null) {
    return unreadable(ALERT_KIND_LABELS.AI_BUDGET_THRESHOLD);
  }

  return {
    title: ALERT_KIND_LABELS.AI_BUDGET_THRESHOLD,
    reason: `Budget IA ${inputs.scope} (${inputs.currency}, ${monthLabelOf(inputs.month)}) : ${actual} dépensés pour ${planned} prévus, soit ${frenchNumber(inputs.percent)} % — le seuil d'alerte de ${frenchNumber(inputs.thresholdPercent)} % est atteint, sans dépassement pour l'instant.`,
    tone: "warning",
  };
}

/** An alert whose stored inputs cannot be read is explained as such, never rendered blank. */
function unreadable(title: string): DescribedAlert {
  return {
    title,
    reason:
      "Données de l'alerte incomplètes : relancez une vérification pour la recalculer.",
    tone: "warning",
  };
}

/**
 * The French text of one alert, recomputed from its stored inputs.
 *
 * Unreadable inputs produce an honest "recalculate" message instead of an empty cell:
 * rows written by an older version or a hand-edited database must never crash a page.
 */
export function describeAlert(alert: { kind: AlertKind; inputs: unknown }): DescribedAlert {
  const parsed: Record<
    AlertKind,
    (value: unknown) => DescribedAlert
  > = {
    LOW_BALANCE: (value) => {
      const result = LOW_BALANCE_INPUTS.safeParse(value);
      return result.success ? describeLowBalance(result.data) : unreadable(ALERT_KIND_LABELS.LOW_BALANCE);
    },
    BUDGET_OVERRUN: (value) => {
      const result = BUDGET_OVERRUN_INPUTS.safeParse(value);
      return result.success ? describeBudgetOverrun(result.data) : unreadable(ALERT_KIND_LABELS.BUDGET_OVERRUN);
    },
    BUDGET_THRESHOLD: (value) => {
      const result = BUDGET_THRESHOLD_INPUTS.safeParse(value);
      return result.success ? describeBudgetThreshold(result.data) : unreadable(ALERT_KIND_LABELS.BUDGET_THRESHOLD);
    },
    UNUSUAL_EXPENSE: (value) => {
      const result = UNUSUAL_EXPENSE_INPUTS.safeParse(value);
      return result.success ? describeUnusualExpense(result.data) : unreadable(ALERT_KIND_LABELS.UNUSUAL_EXPENSE);
    },
    STALE_INTEGRATION: (value) => {
      const result = STALE_INTEGRATION_INPUTS.safeParse(value);
      return result.success ? describeStaleIntegration(result.data) : unreadable(ALERT_KIND_LABELS.STALE_INTEGRATION);
    },
    OVERDUE_EVENT: (value) => {
      const result = OVERDUE_EVENT_INPUTS.safeParse(value);
      return result.success ? describeOverdueEvent(result.data) : unreadable(ALERT_KIND_LABELS.OVERDUE_EVENT);
    },
    AI_BUDGET_OVERRUN: (value) => {
      const result = AI_BUDGET_OVERRUN_INPUTS.safeParse(value);
      return result.success ? describeAiBudgetOverrun(result.data) : unreadable(ALERT_KIND_LABELS.AI_BUDGET_OVERRUN);
    },
    AI_BUDGET_THRESHOLD: (value) => {
      const result = AI_BUDGET_THRESHOLD_INPUTS.safeParse(value);
      return result.success ? describeAiBudgetThreshold(result.data) : unreadable(ALERT_KIND_LABELS.AI_BUDGET_THRESHOLD);
    },
  };

  return parsed[alert.kind](alert.inputs);
}

/*
 * Rule configuration.
 */

export type AlertRuleConfig = {
  kind: AlertKind;
  enabled: boolean;
  /** Amount floor (LOW_BALANCE) or expense threshold (UNUSUAL_EXPENSE). */
  thresholdAmount: Decimal | null;
  /** The single currency an amount threshold applies to; null means "zero applies to all". */
  thresholdCurrency: Currency | null;
  /** Overrun margin, in percent of the planned amount (BUDGET_OVERRUN). */
  thresholdPercent: Decimal | null;
  /** Staleness, in days (STALE_INTEGRATION), or grace, in days (OVERDUE_EVENT). */
  thresholdDays: number | null;
};

/**
 * What each rule does, spelled out — the settings screen shows these lines next to the
 * fields, so a threshold is never a mystery.
 */
export const ALERT_RULE_DESCRIPTIONS: Record<AlertKind, string> = {
  LOW_BALANCE:
    "Déclenche quand le solde enregistré d'un compte passe sous son seuil. Un seuil défini sur le compte (onglet Comptes) est prioritaire et reste actif même si cette règle globale est désactivée ; à défaut, cette règle globale s'applique. Un compte sans aucune opération n'est pas « à zéro » : il n'est pas évalué. Un seuil global de zéro vaut pour toutes les devises ; un seuil supérieur ne compare que les comptes dans sa devise (aucune conversion n'est faite).",
  BUDGET_OVERRUN:
    "Déclenche quand le réalisé d'un budget de dépense dépasse le montant planifié du mois (règle du Suivi : remboursements déduits, opérations du mois uniquement). La marge est le pourcentage de dépassement à partir duquel l'alerte apparaît.",
  BUDGET_THRESHOLD:
    "Déclenche quand le réalisé d'un budget de dépense atteint le pourcentage configuré du montant planifié, sans l'avoir encore dépassé : c'est l'alerte préventive, avant le dépassement. Sur un même mois, elle se résout d'elle-même dès que le dépassement prend le relais. Un mois incomplètement lu ne produit aucune alerte.",
  UNUSUAL_EXPENSE:
    "Déclenche pour une dépense du mois en cours dont le montant atteint ou dépasse le seuil, dans sa devise. Les opérations portant une référence (prévisions confirmées, salaire) sont exclues : elles ne sont pas inhabituelles par construction. Seuil strictement positif requis.",
  STALE_INTEGRATION:
    "Déclenche quand la dernière synchronisation réussie d'une connexion dépasse le seuil en jours. Une connexion jamais synchronisée n'est pas « ancienne » : elle est signalée sur la page Intégrations.",
  OVERDUE_EVENT:
    "Déclenche quand une échéance de flux immobilier est dépassée et non réglée depuis plus de jours que la grâce accordée. La grâce de zéro déclenche dès le lendemain de l'échéance.",
  AI_BUDGET_OVERRUN:
    "Déclenche quand la dépense IA du mois civil (entrées du registre dont la période commence dans le mois, remboursements déduits) dépasse un budget IA (onglet Budgets des Coûts IA), dans sa devise — aucune conversion. La marge est le pourcentage de dépassement à partir duquel l'alerte apparaît. Un budget sans aucune entrée ce mois-ci reste silencieux.",
  AI_BUDGET_THRESHOLD:
    "Déclenche quand la dépense IA du mois atteint le pourcentage configuré d'un budget IA, sans l'avoir encore dépassé. Elle se résout d'elle-même dès que le dépassement prend le relais. Un budget sans aucune entrée ce mois-ci reste silencieux.",
};

/** Applied when no row is stored yet, so the engine runs before any configuration. */
export const ALERT_RULE_DEFAULTS: Record<AlertKind, AlertRuleConfig> = {
  LOW_BALANCE: {
    kind: "LOW_BALANCE",
    enabled: true,
    // Zero is meaningful in every currency: only overdrawn accounts are flagged.
    thresholdAmount: new Decimal(0),
    thresholdCurrency: null,
    thresholdPercent: null,
    thresholdDays: null,
  },
  BUDGET_OVERRUN: {
    kind: "BUDGET_OVERRUN",
    enabled: true,
    thresholdAmount: null,
    thresholdCurrency: null,
    thresholdPercent: new Decimal(0),
    thresholdDays: null,
  },
  BUDGET_THRESHOLD: {
    kind: "BUDGET_THRESHOLD",
    enabled: true,
    thresholdAmount: null,
    thresholdCurrency: null,
    // Eighty percent of the envelope: late enough to be meaningful, early enough to act.
    thresholdPercent: new Decimal(80),
    thresholdDays: null,
  },
  UNUSUAL_EXPENSE: {
    kind: "UNUSUAL_EXPENSE",
    enabled: true,
    thresholdAmount: new Decimal(500),
    thresholdCurrency: DEFAULT_CURRENCY,
    thresholdPercent: null,
    thresholdDays: null,
  },
  STALE_INTEGRATION: {
    kind: "STALE_INTEGRATION",
    enabled: true,
    thresholdAmount: null,
    thresholdCurrency: null,
    thresholdPercent: null,
    thresholdDays: 1,
  },
  OVERDUE_EVENT: {
    kind: "OVERDUE_EVENT",
    enabled: true,
    thresholdAmount: null,
    thresholdCurrency: null,
    thresholdPercent: null,
    thresholdDays: 0,
  },
  AI_BUDGET_OVERRUN: {
    kind: "AI_BUDGET_OVERRUN",
    enabled: true,
    thresholdAmount: null,
    thresholdCurrency: null,
    thresholdPercent: new Decimal(0),
    thresholdDays: null,
  },
  AI_BUDGET_THRESHOLD: {
    kind: "AI_BUDGET_THRESHOLD",
    enabled: true,
    thresholdAmount: null,
    thresholdCurrency: null,
    // Same preventive level as the personal budgets.
    thresholdPercent: new Decimal(80),
    thresholdDays: null,
  },
};

/** One stored rule row, as the repository returns it. */
export type AlertRuleRow = {
  kind: AlertKind;
  enabled: boolean;
  thresholdAmount: Decimal | null;
  thresholdCurrency: Currency | null;
  thresholdPercent: Decimal | null;
  thresholdDays: number | null;
};

/**
 * The effective configuration: stored rows over the defaults, one per kind, in the
 * canonical order. A missing row is not an error — it is the default rule.
 */
export function resolveAlertRules(rows: readonly AlertRuleRow[]): AlertRuleConfig[] {
  const byKind = new Map(rows.map((row) => [row.kind, row]));

  return ALERT_KINDS.map((kind) => {
    const defaults = ALERT_RULE_DEFAULTS[kind];
    const row = byKind.get(kind);

    if (!row) {
      return defaults;
    }

    return {
      kind,
      enabled: row.enabled,
      thresholdAmount: row.thresholdAmount ?? defaults.thresholdAmount,
      thresholdCurrency: row.thresholdCurrency ?? defaults.thresholdCurrency,
      thresholdPercent: row.thresholdPercent ?? defaults.thresholdPercent,
      thresholdDays: row.thresholdDays ?? defaults.thresholdDays,
    };
  });
}

/* Form contract, strings only like every other form of the app. */

const optionalCurrencyCode = z
  .string()
  .trim()
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    try {
      return assertCurrency(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Devise non prise en charge." });
      return z.NEVER;
    }
  });

const optionalAmountField = z
  .string()
  .trim()
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    try {
      return new Decimal(value.replace(/\s/g, "").replace(",", "."));
    } catch {
      ctx.addIssue({ code: "custom", message: "Montant invalide. Exemple : 100,00." });
      return z.NEVER;
    }
  });

const optionalPercentField = optionalAmountField.superRefine((value, ctx) => {
  if (value === null) {
    return;
  }

  if (value.lessThan(0) || value.greaterThan(1000)) {
    ctx.addIssue({ code: "custom", message: "Pourcentage attendu entre 0 et 1000." });
  }
});

const optionalDaysField = z
  .string()
  .trim()
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      ctx.addIssue({ code: "custom", message: "Nombre de jours attendu entre 0 et 3650." });
      return z.NEVER;
    }

    return parsed;
  });

const amountRuleBlock = z.object({
  enabled: z.boolean(),
  thresholdAmount: optionalAmountField,
  thresholdCurrency: optionalCurrencyCode,
});

/**
 * The rules the settings form edits, one block per kind.
 *
 * A positive amount threshold without a currency is refused rather than guessed: the
 * app never converts, so the field says in which currency the threshold reads. A zero
 * threshold is allowed without one — zero means the same in every currency.
 */
export const alertRulesInputSchema = z.object({
  lowBalance: amountRuleBlock.superRefine((value, ctx) => {
    if (value.thresholdAmount === null) {
      return;
    }

    if (value.thresholdAmount.lessThan(0)) {
      ctx.addIssue({
        code: "custom",
        path: ["thresholdAmount"],
        message: "Le seuil ne peut pas être négatif.",
      });
    }

    if (value.thresholdAmount.greaterThan(0) && value.thresholdCurrency === null) {
      ctx.addIssue({
        code: "custom",
        path: ["thresholdCurrency"],
        message: "Devise requise pour un seuil supérieur à zéro.",
      });
    }
  }),
  budgetOverrun: z.object({
    enabled: z.boolean(),
    thresholdPercent: optionalPercentField,
  }),
  budgetThreshold: z.object({
    enabled: z.boolean(),
    thresholdPercent: optionalPercentField,
  }),
  unusualExpense: amountRuleBlock.superRefine((value, ctx) => {
    if (!value.enabled && value.thresholdAmount === null) {
      return;
    }

    if (value.thresholdAmount === null || !value.thresholdAmount.greaterThan(0)) {
      ctx.addIssue({
        code: "custom",
        path: ["thresholdAmount"],
        message: "Seuil strictement positif requis.",
      });
      return;
    }

    if (value.thresholdCurrency === null) {
      ctx.addIssue({
        code: "custom",
        path: ["thresholdCurrency"],
        message: "Devise requise : aucune conversion n'est faite.",
      });
    }
  }),
  staleIntegration: z
    .object({
      enabled: z.boolean(),
      thresholdDays: optionalDaysField,
    })
    .superRefine((value, ctx) => {
      // Zero days would call a fresh sync stale a second later; "not synced yet" is a
      // missing value, and the Integrations page already reports it.
      if (value.thresholdDays !== null && value.thresholdDays < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["thresholdDays"],
          message: "Au moins 1 jour.",
        });
      }
    }),
  overdueEvent: z.object({
    enabled: z.boolean(),
    thresholdDays: optionalDaysField,
  }),
  aiBudgetOverrun: z.object({
    enabled: z.boolean(),
    thresholdPercent: optionalPercentField,
  }),
  aiBudgetThreshold: z.object({
    enabled: z.boolean(),
    thresholdPercent: optionalPercentField,
  }),
});

export type AlertRulesInput = z.output<typeof alertRulesInputSchema>;

/**
 * The form's own field type: the schema's **input** side, field by field — the shape
 * react-hook-form edits before any conversion runs.
 */
export type AlertRulesFormValues = z.input<typeof alertRulesInputSchema>;

/**
 * The effective configuration prepared for the form, as strings — a `Decimal` cannot
 * cross into a client component.
 */
export function toAlertRulesFormValues(
  rules: readonly AlertRuleConfig[],
): AlertRulesFormValues {
  const byKind = new Map(rules.map((rule) => [rule.kind, rule]));
  const amount = (kind: AlertKind): string => byKind.get(kind)?.thresholdAmount?.toFixed(2) ?? "";

  return {
    lowBalance: {
      enabled: byKind.get("LOW_BALANCE")?.enabled ?? true,
      thresholdAmount: amount("LOW_BALANCE"),
      thresholdCurrency: byKind.get("LOW_BALANCE")?.thresholdCurrency ?? "",
    },
    budgetOverrun: {
      enabled: byKind.get("BUDGET_OVERRUN")?.enabled ?? true,
      thresholdPercent: byKind.get("BUDGET_OVERRUN")?.thresholdPercent?.toString() ?? "",
    },
    budgetThreshold: {
      enabled: byKind.get("BUDGET_THRESHOLD")?.enabled ?? true,
      thresholdPercent: byKind.get("BUDGET_THRESHOLD")?.thresholdPercent?.toString() ?? "",
    },
    unusualExpense: {
      enabled: byKind.get("UNUSUAL_EXPENSE")?.enabled ?? true,
      thresholdAmount: amount("UNUSUAL_EXPENSE"),
      thresholdCurrency: byKind.get("UNUSUAL_EXPENSE")?.thresholdCurrency ?? "",
    },
    staleIntegration: {
      enabled: byKind.get("STALE_INTEGRATION")?.enabled ?? true,
      thresholdDays: byKind.get("STALE_INTEGRATION")?.thresholdDays?.toString() ?? "",
    },
    overdueEvent: {
      enabled: byKind.get("OVERDUE_EVENT")?.enabled ?? true,
      thresholdDays: byKind.get("OVERDUE_EVENT")?.thresholdDays?.toString() ?? "",
    },
    aiBudgetOverrun: {
      enabled: byKind.get("AI_BUDGET_OVERRUN")?.enabled ?? true,
      thresholdPercent: byKind.get("AI_BUDGET_OVERRUN")?.thresholdPercent?.toString() ?? "",
    },
    aiBudgetThreshold: {
      enabled: byKind.get("AI_BUDGET_THRESHOLD")?.enabled ?? true,
      thresholdPercent: byKind.get("AI_BUDGET_THRESHOLD")?.thresholdPercent?.toString() ?? "",
    },
  };
}
