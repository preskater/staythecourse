import Decimal from "decimal.js";
import { getPrisma } from "@/lib/db";
import { assertCurrency, type Currency } from "@/lib/money";
import type { AlertKind, AlertRuleConfig, AlertRuleRow, AlertStatus } from "./domain";
import type { AlertLifecyclePlan } from "./lifecycle";

/**
 * Alert persistence (BP-05). Every statement is scoped to the workspace.
 *
 * `applyAlertPlan` is the only writer of the lifecycle: it creates the new episodes,
 * refreshes the ones still holding (inputs and `lastSeenAt`), reopens the resolved ones
 * that triggered again, and resolves the ones whose condition disappeared.
 */

export type AlertRecord = {
  id: string;
  kind: AlertKind;
  fingerprint: string;
  status: AlertStatus;
  /** Stored message inputs, recomputed into the reason by `describeAlert`. */
  inputs: unknown;
  triggeredAt: Date;
  lastSeenAt: Date;
  dismissedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

const ALERT_SELECT = {
  id: true,
  kind: true,
  fingerprint: true,
  status: true,
  inputs: true,
  triggeredAt: true,
  lastSeenAt: true,
  dismissedAt: true,
  resolvedAt: true,
  createdAt: true,
} as const;

/** Declared structurally, so the mapper does not depend on the generated client type. */
type AlertRow = {
  id: string;
  kind: string;
  fingerprint: string;
  status: string;
  inputs: unknown;
  triggeredAt: Date;
  lastSeenAt: Date;
  dismissedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

function toAlertRecord(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    kind: row.kind as AlertKind,
    fingerprint: row.fingerprint,
    status: row.status as AlertStatus,
    inputs: row.inputs,
    triggeredAt: row.triggeredAt,
    lastSeenAt: row.lastSeenAt,
    dismissedAt: row.dismissedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

/** Status reading order: what needs attention first. */
const STATUS_ORDER: AlertStatus[] = ["ACTIVE", "DISMISSED", "RESOLVED"];

/**
 * Every alert of this owner, active first, most recently triggered first inside a group.
 * The table is small by construction (one row per watched condition), so it is read
 * whole — the lifecycle needs all fingerprints anyway. A caller that only displays or
 * exports a slice may pass a status and a row bound.
 */
export async function listAlerts(
  workspaceId: string,
  options: {
    status?: AlertStatus;
    take?: number;
    /** Inclusive lower bound on the trigger instant. */
    from?: Date;
    /** Exclusive upper bound on the trigger instant. */
    to?: Date;
  } = {},
): Promise<AlertRecord[]> {
  const rows = await getPrisma().alert.findMany({
    where: {
      workspaceId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.from || options.to
        ? {
            triggeredAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lt: options.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { triggeredAt: "desc" },
    ...(options.take ? { take: options.take } : {}),
    select: ALERT_SELECT,
  });

  return rows
    .map(toAlertRecord)
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        b.triggeredAt.getTime() - a.triggeredAt.getTime(),
    );
}

/**
 * Writes one evaluation pass.
 *
 * The plan was computed from the rows read moments ago; the operations carry it out in
 * one transaction. `createMany` skips duplicates so a concurrent pass racing this one
 * cannot raise a unique-constraint error — the other pass simply wins.
 */
export async function applyAlertPlan(
  workspaceId: string,
  plan: AlertLifecyclePlan,
  now: Date,
): Promise<void> {
  const prisma = getPrisma();

  if (plan.creates.length > 0) {
    await prisma.alert.createMany({
      data: plan.creates.map((candidate) => ({
        workspaceId,
        kind: candidate.kind,
        fingerprint: candidate.fingerprint,
        status: "ACTIVE" as const,
        // Stored as-is: plain strings and nulls, never the displayed sentence.
        inputs: candidate.inputs as never,
        triggeredAt: now,
        lastSeenAt: now,
      })),
      skipDuplicates: true,
    });
  }

  const operations = [
    ...plan.refreshes.map((entry) =>
      prisma.alert.updateMany({
        where: { id: entry.id, workspaceId },
        data: { inputs: entry.candidate.inputs as never, lastSeenAt: now },
      }),
    ),
    ...plan.reopens.map((entry) =>
      prisma.alert.updateMany({
        where: { id: entry.id, workspaceId },
        data: {
          status: "ACTIVE" as const,
          inputs: entry.candidate.inputs as never,
          // A re-trigger is a new episode: fresh start, dismissal cleared.
          triggeredAt: now,
          lastSeenAt: now,
          dismissedAt: null,
          resolvedAt: null,
        },
      }),
    ),
    ...(plan.resolves.length > 0
      ? [
          prisma.alert.updateMany({
            where: { id: { in: plan.resolves }, workspaceId },
            data: { status: "RESOLVED" as const, resolvedAt: now },
          }),
        ]
      : []),
  ];

  if (operations.length > 0) {
    await prisma.$transaction(operations);
  }
}

/**
 * Dismisses one active alert. `false` means "not found, not yours, or not active any
 * more" — a dismissal is refused rather than rewriting a resolved episode.
 */
export async function dismissAlert(workspaceId: string, alertId: string, now: Date): Promise<boolean> {
  const { count } = await getPrisma().alert.updateMany({
    where: { id: alertId, workspaceId, status: "ACTIVE" },
    data: { status: "DISMISSED", dismissedAt: now },
  });

  return count === 1;
}

/** The stored rule rows, raw: `resolveAlertRules` merges them over the defaults. */
export async function listAlertRules(workspaceId: string): Promise<AlertRuleRow[]> {
  const rows = await getPrisma().alertRule.findMany({
    where: { workspaceId },
    orderBy: { kind: "asc" },
  });

  return rows.map((row) => ({
    kind: row.kind as AlertKind,
    enabled: row.enabled,
    thresholdAmount: row.thresholdAmount === null ? null : new Decimal(row.thresholdAmount.toString()),
    thresholdCurrency:
      row.thresholdCurrency === null ? null : assertCurrency(row.thresholdCurrency),
    thresholdPercent:
      row.thresholdPercent === null ? null : new Decimal(row.thresholdPercent.toString()),
    thresholdDays: row.thresholdDays,
  }));
}

/**
 * Saves the whole configuration, one row per kind.
 *
 * Only the fields a kind uses are stored: switching a threshold off clears the column
 * rather than leaving values that no rule would read.
 */
export async function saveAlertRules(
  workspaceId: string,
  rules: readonly AlertRuleConfig[],
): Promise<void> {
  const prisma = getPrisma();

  await prisma.$transaction(
    rules.map((rule) => {
      const data = ruleRowData(rule);

      return prisma.alertRule.upsert({
        where: { workspaceId_kind: { workspaceId, kind: rule.kind } },
        create: { workspaceId, kind: rule.kind, ...data },
        update: data,
      });
    }),
  );
}

function ruleRowData(rule: AlertRuleConfig): {
  enabled: boolean;
  thresholdAmount: string | null;
  thresholdCurrency: Currency | null;
  thresholdPercent: string | null;
  thresholdDays: number | null;
} {
  const empty = {
    enabled: rule.enabled,
    thresholdAmount: null,
    thresholdCurrency: null,
    thresholdPercent: null,
    thresholdDays: null,
  };

  switch (rule.kind) {
    case "LOW_BALANCE":
    case "UNUSUAL_EXPENSE":
      return {
        ...empty,
        thresholdAmount: rule.thresholdAmount?.toFixed(2) ?? null,
        thresholdCurrency: rule.thresholdCurrency,
      };
    case "BUDGET_OVERRUN":
      return { ...empty, thresholdPercent: rule.thresholdPercent?.toFixed(2) ?? null };
    case "BUDGET_THRESHOLD":
    case "AI_BUDGET_OVERRUN":
    case "AI_BUDGET_THRESHOLD":
      return { ...empty, thresholdPercent: rule.thresholdPercent?.toFixed(2) ?? null };
    case "STALE_INTEGRATION":
    case "OVERDUE_EVENT":
      return { ...empty, thresholdDays: rule.thresholdDays };
  }
}
