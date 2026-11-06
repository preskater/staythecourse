"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { invalidResult, rejectedResult, unexpectedResult, type ActionResult } from "@/lib/actions";
import { requireUser } from "@/lib/auth/guard";
import { MODULE_CATALOG } from "@/modules/catalog/catalog";
import { applyModuleChange } from "@/modules/catalog/repository";
import { hasPermission } from "@/modules/identity/permissions";

const moduleToggleInput = z.object({ key: z.string(), enabled: z.boolean() });

/**
 * Enables or disables one module of the session's workspace.
 *
 * The workspace comes from the session, never from the request; the key is checked
 * against the catalog by `applyModuleChange`. Only the activation row changes: the
 * module's records stay, and reappear on the next render once it is enabled again.
 */
export async function setModuleEnabledAction(values: unknown): Promise<ActionResult> {
  const user = await requireUser();

  if (!hasPermission(user.workspace.role, "manage-modules")) {
    return {
      status: "error",
      message: "Seuls le propriétaire et les administrateurs de l'espace peuvent changer ses modules.",
    };
  }

  const parsed = moduleToggleInput.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let change;
  try {
    change = await applyModuleChange(user.workspace.id, parsed.data);
  } catch (error) {
    return unexpectedResult("applyModuleChange", error);
  }

  if (change.status === "unknown_module" || change.status === "invalid_config") {
    return rejectedResult("key", "Module inconnu.");
  }
  if (change.status === "missing_prerequisites") {
    const missing = change.missing.map((key) => MODULE_CATALOG[key].label).join(", ");
    return rejectedResult("key", `Activez d'abord : ${missing}.`);
  }

  // Navigation and dashboard are rendered from the entitlements: refresh every page.
  revalidatePath("/", "layout");
  return { status: "ok" };
}
