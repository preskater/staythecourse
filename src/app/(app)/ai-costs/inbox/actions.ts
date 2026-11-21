"use server";

import { revalidatePath } from "next/cache";
import { requireModule } from "@/lib/auth/guard";
import {
  allocationFailureReason,
  applyPolicySubmissionSchema,
  describeDimensions,
  finalizeSubmissionSchema,
  type InboxActionResult,
  type InboxEntryOutcome,
} from "@/modules/ai-costs/inbox";
import { applyAllocationPolicy, findAllocationPolicy } from "@/modules/ai-costs/policy.repository";
import { finalizeCostEntry } from "@/modules/ai-costs/repository";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { canManageBusinessRecords } from "@/modules/identity/workspace";

/**
 * Bulk actions of the unallocated-cost inbox (M9-06).
 *
 * Every action re-checks the session, the module and the role; identifiers from the
 * browser are only looked up inside the signed-in workspace. Entries are processed one
 * by one, each in its own transaction: one refusal (finalized meanwhile, nothing left
 * to split) is reported with its reason and never blocks the others. A preview writes
 * nothing and is not audited; an apply or a finalization leaves one audit entry with
 * the actor and counts only.
 */

const MANAGER_MESSAGE = "Seuls le propriétaire et les administrateurs de l'espace peuvent répartir ou valider des coûts.";

async function guard() {
  const user = await requireModule("ai-costs", "write");
  return canManageBusinessRecords(user.workspace.role) ? user : null;
}

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Demande invalide.";
}

function refresh() {
  revalidatePath("/ai-costs/inbox");
  revalidatePath("/dashboard");
}

export async function applyPolicyToEntriesAction(values: unknown): Promise<InboxActionResult> {
  const user = await guard();
  if (!user) return { status: "error", message: MANAGER_MESSAGE };

  const parsed = applyPolicySubmissionSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", message: firstIssue(parsed.error) };

  const input = parsed.data;
  const workspaceId = user.workspace.id;
  const policy = await findAllocationPolicy(workspaceId, input.policyId);

  if (!policy) return { status: "invalid", message: "Politique introuvable." };
  if (policy.archivedAt) return { status: "invalid", message: "Cette politique est archivée." };

  const outcomes: InboxEntryOutcome[] = [];

  for (const entryId of input.entryIds) {
    try {
      const applied = await applyAllocationPolicy(workspaceId, {
        entryId,
        policyId: policy.id,
        measures: input.measures,
        dryRun: input.dryRun,
      });
      outcomes.push({
        entryId,
        ok: true,
        reason: null,
        planned: applied.planned.map((row) => ({
          dimensions: describeDimensions(row.dimensions),
          amount: row.amount,
          measure: row.measure,
        })),
      });
    } catch (error) {
      outcomes.push({ entryId, ok: false, reason: allocationFailureReason(error), planned: [] });
    }
  }

  const succeeded = outcomes.filter((outcome) => outcome.ok).length;

  if (!input.dryRun) {
    await recordAuditEventSafely({
      workspaceId,
      actorId: user.id,
      action: "cost.allocate",
      entityType: "COST_ENTRY",
      entityId: policy.latestVersion.id,
      outcome: succeeded > 0 ? "SUCCESS" : "REFUSED",
      metadata: {
        policyKind: policy.kind,
        policyVersion: policy.latestVersion.version,
        requested: outcomes.length,
        allocated: succeeded,
        refused: outcomes.length - succeeded,
      },
    });
    refresh();
  }

  return {
    status: "ok",
    message: input.dryRun
      ? `Aperçu : ${succeeded} coût(s) répartissable(s) sur ${outcomes.length}. Rien n'est enregistré.`
      : `${succeeded} coût(s) réparti(s) sur ${outcomes.length} avec « ${policy.name} » (version ${policy.latestVersion.version}).`,
    outcomes,
  };
}

/** Finalization is never automatic: only this explicit, bounded action locks entries. */
export async function finalizeEntriesAction(values: unknown): Promise<InboxActionResult> {
  const user = await guard();
  if (!user) return { status: "error", message: MANAGER_MESSAGE };

  const parsed = finalizeSubmissionSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", message: firstIssue(parsed.error) };

  const workspaceId = user.workspace.id;
  const outcomes: InboxEntryOutcome[] = [];

  for (const entryId of parsed.data.entryIds) {
    try {
      const found = await finalizeCostEntry(workspaceId, entryId);
      outcomes.push(
        found
          ? { entryId, ok: true, reason: null, planned: [] }
          : { entryId, ok: false, reason: "Coût introuvable dans cet espace.", planned: [] },
      );
    } catch (error) {
      outcomes.push({ entryId, ok: false, reason: allocationFailureReason(error), planned: [] });
    }
  }

  const succeeded = outcomes.filter((outcome) => outcome.ok).length;

  await recordAuditEventSafely({
    workspaceId,
    actorId: user.id,
    action: "cost.finalize",
    entityType: "COST_ENTRY",
    outcome: succeeded > 0 ? "SUCCESS" : "REFUSED",
    metadata: { requested: outcomes.length, finalized: succeeded, refused: outcomes.length - succeeded },
  });
  refresh();

  return {
    status: "ok",
    message: `${succeeded} coût(s) validé(s) sur ${outcomes.length}. Un coût validé ne peut plus être réparti.`,
    outcomes,
  };
}
