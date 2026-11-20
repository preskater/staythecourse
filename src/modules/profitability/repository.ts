import Decimal from "decimal.js";
import { getPrisma } from "@/lib/db";
import type { ProfitabilityInputs } from "./rules";

/**
 * What the profitability calculation (M15-01) reads, workspace-scoped: projects, the
 * revenue documents that can be recognised in the range (issued or recognised in it),
 * and the cost entries whose period starts in it, with their allocations.
 *
 * Authorization is the caller's job (`service.ts`): margins are confidential.
 */

/** Upper bound per read: a calculation on a truncated read would be wrong, not partial. */
export const MAX_PROFITABILITY_ROWS = 10_000;

export class ProfitabilityInputTooLargeError extends Error {
  constructor() {
    super(`More than ${MAX_PROFITABILITY_ROWS} rows in the range: narrow the period.`);
    this.name = "ProfitabilityInputTooLargeError";
  }
}

const decimal = (value: Decimal.Value) => new Decimal(value.toString());

export async function readProfitabilityInputs(
  workspaceId: string,
  period: { from: Date; to: Date },
): Promise<ProfitabilityInputs> {
  const prisma = getPrisma();
  const inRange = { gte: period.from, lte: period.to };

  const [projects, documents, entries] = await Promise.all([
    prisma.project.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
    prisma.revenueDocument.findMany({
      where: { workspaceId, OR: [{ issuedOn: inRange }, { recognizedOn: inRange }] },
      select: {
        projectId: true,
        currency: true,
        kind: true,
        amount: true,
        issuedOn: true,
        recognizedOn: true,
        recognizedAmount: true,
      },
      take: MAX_PROFITABILITY_ROWS + 1,
    }),
    prisma.costEntry.findMany({
      where: { workspaceId, periodStart: inRange },
      select: {
        amount: true,
        currency: true,
        periodStart: true,
        projectId: true,
        allocations: { select: { amount: true, projectId: true } },
      },
      take: MAX_PROFITABILITY_ROWS + 1,
    }),
  ]);

  if (documents.length > MAX_PROFITABILITY_ROWS || entries.length > MAX_PROFITABILITY_ROWS) {
    throw new ProfitabilityInputTooLargeError();
  }

  return {
    projects,
    revenueDocuments: documents.map((document) => ({
      ...document,
      currency: document.currency.trim(),
      amount: decimal(document.amount),
      recognizedAmount: document.recognizedAmount === null ? null : decimal(document.recognizedAmount),
    })),
    costEntries: entries.map((entry) => ({
      ...entry,
      currency: entry.currency.trim(),
      amount: decimal(entry.amount),
      allocations: entry.allocations.map((allocation) => ({
        projectId: allocation.projectId,
        amount: decimal(allocation.amount),
      })),
    })),
  };
}
