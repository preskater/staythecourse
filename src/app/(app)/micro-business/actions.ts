"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  isUniqueConstraintError,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import {
  archiveInputSchema,
  clientInputSchema,
  clientUpdateSchema,
  projectInputSchema,
  projectUpdateSchema,
} from "@/modules/micro-business/domain";
import {
  createClient,
  createProject,
  findClient,
  findProject,
  setClientArchived,
  setProjectArchived,
  updateClient,
  updateProject,
} from "@/modules/micro-business/repository";
import { requireBusinessManager } from "./manager-guard";

/**
 * Write Server Actions for the micro-business module.
 *
 * Same contract as the other modules: the session first, then the module entitlement,
 * then the role (see `manager-guard.ts`). Only the workspace's owner and admins write
 * commercial records — a `MEMBER` or `VIEWER` reads them and writes nothing. Every
 * identifier from the browser is looked up workspace-scoped, so a foreign one is
 * "not found".
 */

function refreshBusinessPages(): void {
  revalidatePath("/micro-business");
}

const CLIENT_NOT_FOUND = "Client introuvable : il a peut-être déjà été supprimé.";
const PROJECT_NOT_FOUND = "Projet introuvable : il a peut-être déjà été supprimé.";
const DUPLICATE_CLIENT = "Un autre client porte déjà ce nom.";
const DUPLICATE_PROJECT = "Un autre projet porte déjà ce nom.";

export async function createClientAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = clientInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    await createClient({ workspaceId: guard.user.workspace.id, ...parsed.data });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", DUPLICATE_CLIENT);
    }

    return unexpectedResult("createClient", error);
  }

  refreshBusinessPages();
  return { status: "ok" };
}

export async function updateClientAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = clientUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { id, ...fields } = parsed.data;

  const existing = await findClient(guard.user.workspace.id, id);
  if (!existing) {
    return rejectedResult("id", CLIENT_NOT_FOUND);
  }

  try {
    const updated = await updateClient(guard.user.workspace.id, id, fields);
    if (!updated) {
      return rejectedResult("id", CLIENT_NOT_FOUND);
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", DUPLICATE_CLIENT);
    }

    return unexpectedResult("updateClient", error);
  }

  refreshBusinessPages();
  return { status: "ok" };
}

export async function setClientArchivedAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = archiveInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const updated = await setClientArchived(
    guard.user.workspace.id,
    parsed.data.id,
    parsed.data.archived,
  );
  if (!updated) {
    return rejectedResult("id", CLIENT_NOT_FOUND);
  }

  refreshBusinessPages();
  return { status: "ok" };
}

export async function createProjectAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = projectInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const input = parsed.data;
  if (input.clientId !== null && !(await findClient(guard.user.workspace.id, input.clientId))) {
    return rejectedResult("clientId", CLIENT_NOT_FOUND);
  }

  try {
    const created = await createProject({ workspaceId: guard.user.workspace.id, ...input });
    if (!created) {
      return rejectedResult("clientId", CLIENT_NOT_FOUND);
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", DUPLICATE_PROJECT);
    }

    return unexpectedResult("createProject", error);
  }

  refreshBusinessPages();
  return { status: "ok" };
}

export async function updateProjectAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = projectUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const { id, ...fields } = parsed.data;

  const existing = await findProject(guard.user.workspace.id, id);
  if (!existing) {
    return rejectedResult("id", PROJECT_NOT_FOUND);
  }

  if (fields.clientId !== null && !(await findClient(guard.user.workspace.id, fields.clientId))) {
    return rejectedResult("clientId", CLIENT_NOT_FOUND);
  }

  try {
    const updated = await updateProject(guard.user.workspace.id, id, fields);
    if (!updated) {
      return rejectedResult("id", PROJECT_NOT_FOUND);
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return rejectedResult("name", DUPLICATE_PROJECT);
    }

    return unexpectedResult("updateProject", error);
  }

  refreshBusinessPages();
  return { status: "ok" };
}

export async function setProjectArchivedAction(values: unknown): Promise<ActionResult> {
  const guard = await requireBusinessManager();
  if ("refusal" in guard) {
    return guard.refusal;
  }

  const parsed = archiveInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  const updated = await setProjectArchived(
    guard.user.workspace.id,
    parsed.data.id,
    parsed.data.archived,
  );
  if (!updated) {
    return rejectedResult("id", PROJECT_NOT_FOUND);
  }

  refreshBusinessPages();
  return { status: "ok" };
}
