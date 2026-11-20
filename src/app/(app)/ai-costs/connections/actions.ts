"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireModule } from "@/lib/auth/guard";
import {
  aiConnectionIdSchema,
  aiConnectionInputSchema,
  connectAiProvider,
  revalidateAiConnection,
  revokeAiConnection,
} from "@/modules/ai-costs/connections";
import { canManageBusinessRecords } from "@/modules/identity/workspace";

/**
 * Server Actions of the AI provider connections (M11-05).
 *
 * Each action re-checks the session, the module and the role on the server, and only
 * looks connections up inside the signed-in workspace. The secret travels once, in
 * the form body; it is never put in a redirect URL, a return value or a log.
 */

const PAGE = "/ai-costs/connections";

async function guard() {
  const user = await requireModule("ai-costs", "write");
  if (!canManageBusinessRecords(user.workspace.role)) redirect(`${PAGE}?status=forbidden`);
  return { workspaceId: user.workspace.id, actorId: user.id };
}

function done(params: Record<string, string>): never {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}`);
}

export async function connectAiProviderAction(formData: FormData): Promise<void> {
  const actor = await guard();
  const parsed = aiConnectionInputSchema.safeParse({
    provider: formData.get("provider"),
    secret: formData.get("secret"),
  });
  if (!parsed.success) done({ status: "invalid" });

  const outcome = await connectAiProvider({ ...actor, ...parsed.data });
  done(outcome.status === "rejected" ? { status: "rejected", code: outcome.code } : { status: outcome.status });
}

export async function revalidateAiConnectionAction(formData: FormData): Promise<void> {
  const actor = await guard();
  const connectionId = aiConnectionIdSchema.safeParse(formData.get("connectionId"));
  if (!connectionId.success) done({ status: "not_found" });

  const outcome = await revalidateAiConnection({ ...actor, connectionId: connectionId.data });
  done("code" in outcome ? { status: outcome.status, code: outcome.code } : { status: outcome.status });
}

export async function revokeAiConnectionAction(formData: FormData): Promise<void> {
  const actor = await guard();
  const connectionId = aiConnectionIdSchema.safeParse(formData.get("connectionId"));
  if (!connectionId.success) done({ status: "not_found" });
  // Destroying a secret is not undoable: the form asks for an explicit confirmation.
  if (formData.get("confirm") !== "yes") done({ status: "unconfirmed" });

  const outcome = await revokeAiConnection({ ...actor, connectionId: connectionId.data });
  done({ status: outcome.status });
}
