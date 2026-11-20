import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/modules/integrations/adapter";
import type { AiPageRequest } from "@/modules/integrations/ai-adapter";
import type { CopilotDay, CopilotSeats } from "@/modules/integrations/copilot";

/**
 * Copilot import (M11-08) against fake tables that honour the unique key
 * `(workspaceId, connectionKey, organization, day)` like PostgreSQL would, so "a re-run
 * creates no duplicate" is checked on the rows. No test reaches GitHub or a database.
 */

const tables = { seats: new Map<string, unknown>(), days: new Map<string, unknown>() };

function upsertInto(table: Map<string, unknown>) {
  return vi.fn(async (args: { where: Record<string, Record<string, unknown>>; create: object; update: object }) => {
    const { workspaceId, connectionKey, organization, day } = Object.values(args.where)[0];
    const key = `${workspaceId}|${connectionKey}|${organization}|${(day as Date).toISOString()}`;
    const existing = table.get(key) as object | undefined;
    table.set(key, existing ? { ...existing, ...args.update } : args.create);
  });
}

const prisma = {
  copilotSeatSnapshot: { upsert: upsertInto(tables.seats) },
  copilotUsageDay: { upsert: upsertInto(tables.days) },
  $transaction: vi.fn(async (work: Promise<unknown>[]) => Promise.all(work)),
};

vi.mock("@/lib/db", () => ({ getPrisma: () => prisma }));
const auditMock = vi.fn();
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: (entry: unknown) => auditMock(entry) }));

const { importCopilotUsage } = await import("./copilot-import");

const seats: CopilotSeats = {
  organization: "acme-fixture",
  planType: "business",
  total: 10,
  activeThisCycle: 8,
  inactiveThisCycle: 2,
  addedThisCycle: 0,
  pendingInvitation: 0,
  pendingCancellation: 0,
  listedSeats: 10,
};

const day = (date: string): CopilotDay => ({
  externalId: `acme-fixture|${date}`,
  organization: "acme-fixture",
  day: date,
  dailyActiveUsers: 3,
  weeklyActiveUsers: null,
  monthlyActiveUsers: 8,
  monthlyActiveAgentUsers: 2,
  dailyActiveCloudAgentUsers: null,
  interactionCount: 12,
  codeGenerationCount: null,
  codeAcceptanceCount: null,
  thirdPartyAgents: [{ agentId: "42", agentName: "Agent fictif", interactions: 1 }],
});

const request = { token: "fake-token", instanceUrl: "", scopeId: "acme-fixture", start: new Date("2026-10-01"), end: new Date("2026-10-03"), cursor: null } as AiPageRequest;
const input = { workspaceId: "ws-1", actorId: "user-1", connectionKey: "copilot-1", request };
const now = () => new Date("2026-10-03T08:00:00Z");
const complete = { records: [day("2026-10-01"), day("2026-10-02")], nextCursor: null, stoppedBy: null, pagesRead: 1, fetchedAt: now() };

beforeEach(() => {
  tables.seats.clear();
  tables.days.clear();
  vi.clearAllMocks();
});

describe("importCopilotUsage", () => {
  it("stores seats and days, and a re-run creates no duplicate", async () => {
    const dependencies = { readSeats: async () => seats, listDays: async () => complete, now };

    const first = await importCopilotUsage(input, dependencies);
    await importCopilotUsage(input, dependencies);

    expect(first).toEqual({ daysImported: 2, seatStatus: "RECONCILED", nextCursor: null, stoppedBy: null });
    expect(tables.seats.size).toBe(1);
    expect(tables.days.size).toBe(2);
    expect(auditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "integration.sync",
        outcome: "SUCCESS",
        metadata: { provider: "GITHUB_COPILOT", kind: "ai_usage", days: 2, pages: 1, stoppedBy: "none", seats: "RECONCILED" },
      }),
    );
  });

  it("keeps a partial run resumable and stores what was read", async () => {
    const partial = { ...complete, records: [day("2026-10-01")], nextCursor: "2026-10-02", stoppedBy: "RATE_LIMITED" as const };
    const result = await importCopilotUsage(input, { readSeats: async () => seats, listDays: async () => partial, now });

    expect(result).toMatchObject({ daysImported: 1, nextCursor: "2026-10-02", stoppedBy: "RATE_LIMITED" });
    expect(tables.days.size).toBe(1);
  });

  it("flags seats that GitHub's own list does not confirm", async () => {
    const result = await importCopilotUsage(input, {
      readSeats: async () => ({ ...seats, listedSeats: 9 }),
      listDays: async () => complete,
      now,
    });
    expect(result.seatStatus).toBe("MISMATCH");
  });

  it("writes nothing on a revoked token and audits the code only", async () => {
    const revoked = new ProviderError("UNAUTHORIZED", "Clé GitHub Copilot invalide ou révoquée.", { status: 401 });
    await expect(
      importCopilotUsage(input, { readSeats: async () => Promise.reject(revoked), listDays: async () => complete, now }),
    ).rejects.toBe(revoked);

    expect(tables.seats.size + tables.days.size).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED", metadata: { provider: "GITHUB_COPILOT", kind: "ai_usage", error: "UNAUTHORIZED" } }),
    );
  });
});
