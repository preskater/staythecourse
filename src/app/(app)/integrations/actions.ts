"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireModule } from "@/lib/auth/guard";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import { connectionInputSchema } from "@/modules/integrations/domain";
import { upsertConnection } from "@/modules/integrations/repository";
import { synchroniseConnection } from "@/jobs/sync";

/**
 * Server Actions for the integrations module.
 *
 * Authorisation is checked here, on the server, and the connection is always
 * looked up for the signed-in owner: a request body can never name another
 * user's connection.
 */

export async function connectProviderAction(formData: FormData): Promise<void> {
  const user = await requireModule("development", "write");

  const parsed = connectionInputSchema.safeParse({
    provider: formData.get("provider"),
    instanceUrl: formData.get("instanceUrl") ?? "",
    externalOwner: formData.get("externalOwner") || null,
    token: formData.get("token"),
  });

  if (!parsed.success) {
    redirect("/integrations?status=invalid");
  }

  const connection = await upsertConnection({
    workspaceId: user.workspace.id,
    provider: parsed.data.provider,
    instanceUrl: parsed.data.instanceUrl,
    externalOwner: parsed.data.externalOwner,
    // Read-only permissions are declared by the adapters, never granted here.
    permissions: [],
    token: parsed.data.token,
  });

  // Covers the first connection and a later token rotation; the token itself is never
  // passed to the trail.
  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "integration.connect",
    entityType: "INTEGRATION",
    entityId: connection.id,
    outcome: "SUCCESS",
    metadata: { provider: parsed.data.provider },
  });

  revalidatePath("/integrations");
  redirect("/integrations?status=connected");
}

export async function syncConnectionAction(formData: FormData): Promise<void> {
  const user = await requireModule("development", "write");
  const connectionId = formData.get("connectionId");

  if (typeof connectionId !== "string" || connectionId === "") {
    redirect("/integrations?sync=invalid");
  }

  // A manual one-shot run. Scheduled synchronisations use the same function from
  // a scheduler outside the web process.
  const result = await synchroniseConnection(user.workspace.id, connectionId, {
    actorId: user.id,
  });

  revalidatePath("/integrations");

  const repository = formData.get("repository");
  const focus = typeof repository === "string" && repository !== "" ? repository : null;

  if (result.status === "SYNCHRONISED") {
    // The stored run carries the counters; the page reads them from the database, so
    // the summary survives a refresh and the URL stays free of duplicated figures.
    const params = new URLSearchParams({ sync: "ok" });

    if (focus) {
      params.set("repo", focus);
    }

    redirect(`/integrations?${params.toString()}`);
  }
  if (result.status === "FAILED") {
    redirect(`/integrations?sync=error&code=${encodeURIComponent(result.code)}`);
  }
  redirect(`/integrations?sync=skipped&reason=${encodeURIComponent(result.reason)}`);
}
