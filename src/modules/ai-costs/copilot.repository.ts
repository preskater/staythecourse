import { getPrisma } from "@/lib/db";
import { toDateOnlyString } from "@/lib/dates";
import type { CopilotDay, CopilotSeats, CopilotThirdPartyAgent } from "@/modules/integrations/copilot";

/**
 * GitHub Copilot storage (M11-08). Both tables are keyed by connection, organization
 * and UTC day: a re-run updates the rows it already holds and never adds a duplicate.
 */

const dayDate = (day: string) => new Date(`${day}T00:00:00Z`);

export async function upsertCopilotSeats(
  workspaceId: string,
  input: { connectionKey: string; seats: CopilotSeats; fetchedAt: Date },
): Promise<void> {
  const { organization, ...counts } = input.seats;
  const key = {
    workspaceId,
    connectionKey: input.connectionKey,
    organization,
    day: dayDate(toDateOnlyString(input.fetchedAt)),
  };

  await getPrisma().copilotSeatSnapshot.upsert({
    where: { workspaceId_connectionKey_organization_day: key },
    create: { ...key, ...counts, fetchedAt: input.fetchedAt },
    update: { ...counts, fetchedAt: input.fetchedAt },
  });
}

export async function upsertCopilotDays(
  workspaceId: string,
  input: { connectionKey: string; days: readonly CopilotDay[]; fetchedAt: Date },
): Promise<number> {
  const prisma = getPrisma();

  await prisma.$transaction(
    input.days.map((record) => {
      const key = { workspaceId, connectionKey: input.connectionKey, organization: record.organization, day: dayDate(record.day) };
      const values = {
        dailyActiveUsers: record.dailyActiveUsers,
        weeklyActiveUsers: record.weeklyActiveUsers,
        monthlyActiveUsers: record.monthlyActiveUsers,
        monthlyActiveAgentUsers: record.monthlyActiveAgentUsers,
        dailyActiveCloudAgentUsers: record.dailyActiveCloudAgentUsers,
        interactionCount: record.interactionCount,
        codeGenerationCount: record.codeGenerationCount,
        codeAcceptanceCount: record.codeAcceptanceCount,
        thirdPartyAgents: record.thirdPartyAgents.map((agent) => ({ ...agent })),
        fetchedAt: input.fetchedAt,
      };

      return prisma.copilotUsageDay.upsert({
        where: { workspaceId_connectionKey_organization_day: key },
        create: { ...key, ...values },
        update: values,
      });
    }),
  );

  return input.days.length;
}

export type CopilotSeatRow = Omit<CopilotSeats, "organization"> & { organization: string; day: string };
export type CopilotDayRow = Omit<CopilotDay, "externalId">;

/** Latest seat reading and latest reported day of each organization of the workspace. */
export async function readCopilotOverview(
  workspaceId: string,
): Promise<{ seats: CopilotSeatRow[]; days: CopilotDayRow[] }> {
  const prisma = getPrisma();
  const [seats, days] = await Promise.all([
    prisma.copilotSeatSnapshot.findMany({
      where: { workspaceId },
      orderBy: [{ organization: "asc" }, { day: "desc" }],
      distinct: ["organization"],
    }),
    prisma.copilotUsageDay.findMany({
      where: { workspaceId },
      orderBy: [{ organization: "asc" }, { day: "desc" }],
      distinct: ["organization"],
    }),
  ]);

  return {
    seats: seats.map((row) => ({
      organization: row.organization,
      day: toDateOnlyString(row.day),
      planType: row.planType,
      total: row.total,
      activeThisCycle: row.activeThisCycle,
      inactiveThisCycle: row.inactiveThisCycle,
      addedThisCycle: row.addedThisCycle,
      pendingInvitation: row.pendingInvitation,
      pendingCancellation: row.pendingCancellation,
      listedSeats: row.listedSeats,
    })),
    days: days.map((row) => ({
      organization: row.organization,
      day: toDateOnlyString(row.day),
      dailyActiveUsers: row.dailyActiveUsers,
      weeklyActiveUsers: row.weeklyActiveUsers,
      monthlyActiveUsers: row.monthlyActiveUsers,
      monthlyActiveAgentUsers: row.monthlyActiveAgentUsers,
      dailyActiveCloudAgentUsers: row.dailyActiveCloudAgentUsers,
      interactionCount: row.interactionCount,
      codeGenerationCount: row.codeGenerationCount,
      codeAcceptanceCount: row.codeAcceptanceCount,
      thirdPartyAgents: row.thirdPartyAgents as CopilotThirdPartyAgent[],
    })),
  };
}
