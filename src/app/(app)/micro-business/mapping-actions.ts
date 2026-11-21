"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { recordIdInput } from "@/lib/validation";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { projectMappingInputSchema } from "@/modules/micro-business/mapping";
import {
  createProjectMapping,
  deleteProjectMapping,
  ProjectMappingError,
} from "@/modules/micro-business/mapping.repository";
import { requireBusinessManager } from "./manager-guard";

/**
 * Server Actions for repository-to-project mappings (M14-01). Owner and admins only,
 * like every commercial record; each change is audited without the repository name.
 */

export async function createProjectMappingAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) return guard.refusal;

  const parsed = projectMappingInputSchema.safeParse(values);
  if (!parsed.success) return invalidResult(parsed.error);

  let created: { id: string };
  try {
    created = await createProjectMapping(guard.user.workspace.id, parsed.data);
  } catch (error) {
    if (error instanceof ProjectMappingError) return rejectedResult(error.field, error.message);
    return unexpectedResult("createProjectMapping", error);
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "project_mapping.create",
    entityType: "PROJECT_MAPPING",
    entityId: created.id,
    outcome: "SUCCESS",
    metadata: { selector: parsed.data.selector },
  });

  revalidatePath("/micro-business/mapping");
  return { status: "ok", message: "Règle ajoutée." };
}

export async function deleteProjectMappingAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) return guard.refusal;

  const parsed = recordIdInput.safeParse(values);
  if (!parsed.success) return invalidResult(parsed.error);

  try {
    if (!(await deleteProjectMapping(guard.user.workspace.id, parsed.data.id))) {
      return rejectedResult("id", "Règle introuvable : elle a peut-être déjà été supprimée.");
    }
  } catch (error) {
    return unexpectedResult("deleteProjectMapping", error);
  }

  await recordAuditEventSafely({
    workspaceId: guard.user.workspace.id,
    actorId: guard.user.id,
    action: "project_mapping.delete",
    entityType: "PROJECT_MAPPING",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
  });

  revalidatePath("/micro-business/mapping");
  return { status: "ok" };
}
