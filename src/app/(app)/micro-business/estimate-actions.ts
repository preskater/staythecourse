"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  isUniqueConstraintError,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { recordIdInput } from "@/lib/validation";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import {
  approveRefusedReason,
  estimateVersionInputSchema,
  parseEstimateItems,
  versionKindRefusedReason,
} from "@/modules/micro-business/estimates";
import {
  approveEstimateVersion,
  createEstimateVersion,
  findProject,
  listEstimateVersions,
} from "@/modules/micro-business/repository";
import { requireBusinessManager } from "./manager-guard";

/**
 * Server Actions for estimate versions (M10-04).
 *
 * Creating a version never edits an existing one. Approving a draft is the only
 * transition, and the repository performs it with the supersede write in one
 * transaction. The first version of a project must be the baseline; later versions are
 * revisions or change requests.
 *
 * ponytail: the first-baseline check reads the project's versions, then writes. Two
 * simultaneous submissions could both pass it; this is a single-owner app, and the
 * unique version number still keeps the ordering consistent. Move the check into the
 * creating transaction if multi-user writes land.
 */

const PROJECT_NOT_FOUND = "Projet introuvable : il a peut-être été supprimé.";
const ARCHIVED_PROJECT =
  "Ce projet est archivé : restaurez-le avant de créer une version de devis.";
const VERSION_NOT_FOUND = "Version introuvable : elle a peut-être été supprimée.";
const CONCURRENT_VERSION =
  "Une autre version vient d'être enregistrée pour ce projet : rechargez la page avant de réessayer.";

function refreshEstimatePages(): void {
  revalidatePath("/micro-business/estimates");
  revalidatePath("/micro-business");
}

export async function createEstimateVersionAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = estimateVersionInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;
  const workspaceId = guard.user.workspace.id;

  const project = await findProject(workspaceId, input.projectId);
  if (!project) {
    return rejectedResult("projectId", PROJECT_NOT_FOUND);
  }
  if (project.archived) {
    return rejectedResult("projectId", ARCHIVED_PROJECT);
  }

  const items = parseEstimateItems(input.items);
  if (!items.ok) {
    return rejectedResult("items", items.message);
  }

  const existing = await listEstimateVersions(workspaceId, project.id);
  const kindRefusal = versionKindRefusedReason(existing.length, input.kind);
  if (kindRefusal) {
    return rejectedResult("kind", kindRefusal);
  }

  let created: { id: string; versionNumber: number } | null;
  try {
    created = await createEstimateVersion({
      workspaceId,
      projectId: project.id,
      kind: input.kind,
      assumptions: input.assumptions,
      notes: input.notes,
      items: items.items,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("projectId", CONCURRENT_VERSION);
    }

    return unexpectedResult("createEstimateVersion", error);
  }

  if (!created) {
    return rejectedResult("projectId", PROJECT_NOT_FOUND);
  }

  await recordAuditEventSafely({
    workspaceId,
    actorId: guard.user.id,
    action: "estimate.version_create",
    entityType: "ESTIMATE",
    entityId: created.id,
    outcome: "SUCCESS",
    metadata: { version: created.versionNumber, kind: input.kind },
  });

  refreshEstimatePages();
  return {
    status: "ok",
    message: `Version ${created.versionNumber} enregistrée en brouillon.`,
  };
}

export async function approveEstimateVersionAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let outcome;
  try {
    outcome = await approveEstimateVersion(guard.user.workspace.id, parsed.data.id);
  } catch (error) {
    return unexpectedResult("approveEstimateVersion", error);
  }

  if (outcome.status === "not_found") {
    return rejectedResult("id", VERSION_NOT_FOUND);
  }
  if (outcome.status === "not_draft") {
    return rejectedResult(
      "id",
      approveRefusedReason(outcome.currentStatus) ??
        "Seule une version en brouillon peut être approuvée.",
    );
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "estimate.approve",
    entityType: "ESTIMATE",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
    metadata: { version: outcome.versionNumber },
  });

  refreshEstimatePages();
  return {
    status: "ok",
    message: `Version ${outcome.versionNumber} approuvée : la version approuvée précédente est remplacée.`,
  };
}
