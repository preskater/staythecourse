import type { SessionUser } from "@/lib/auth/guard";
import { hasPermission } from "@/modules/identity/permissions";
import { readProfitabilityInputs } from "./repository";
import {
  calculateProfitability,
  CURRENT_PROFITABILITY_RULE_VERSION,
  type ProfitabilityResult,
} from "./rules";

/**
 * The one entry point every profitability view uses (M15-01): read the workspace's
 * inputs, then run the pure calculation. Margins expose internal costs, so they follow
 * the confidential-rates permission (owner only until M18-01 refines it).
 */

export class ProfitabilityForbiddenError extends Error {
  constructor() {
    super("Profitability figures require the read-internal-rates permission.");
    this.name = "ProfitabilityForbiddenError";
  }
}

export function canReadProfitability(user: Pick<SessionUser, "workspace">): boolean {
  return hasPermission(user.workspace.role, "read-internal-rates");
}

export async function getProjectProfitability(
  user: Pick<SessionUser, "workspace">,
  period: { from: Date; to: Date },
  version: string = CURRENT_PROFITABILITY_RULE_VERSION,
): Promise<ProfitabilityResult> {
  if (!canReadProfitability(user)) throw new ProfitabilityForbiddenError();

  return calculateProfitability(await readProfitabilityInputs(user.workspace.id, period), period, version);
}
