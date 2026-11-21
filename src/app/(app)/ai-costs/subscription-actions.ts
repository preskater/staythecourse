"use server";

import { revalidatePath } from "next/cache";
import {
  invalidResult,
  rejectedResult,
  unexpectedResult,
  type ActionResult,
} from "@/lib/actions";
import { requireModule } from "@/lib/auth/guard";
import { todayDateOnly } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { recordAuditEventSafely } from "@/modules/audit/repository";
import {
  bookDueRenewals,
  cancelAiSubscription,
  createAiSubscription,
  InvalidSubscriptionError,
} from "@/modules/ai-costs/subscription.repository";
import {
  aiSubscriptionInputSchema,
  cancelSubscriptionInputSchema,
} from "@/modules/ai-costs/subscriptions";

/**
 * Server Actions for the subscription register (M12-05). Same permission as the
 * ledger's writes. Saving books the renewals already due, so the ledger and the
 * register agree as soon as the page reloads.
 */

function refreshPages(): void {
  revalidatePath("/ai-costs");
  revalidatePath("/dashboard");
}

async function bookNow(workspaceId: string): Promise<void> {
  // The subscription is saved: a failed booking is logged and retried on the next render.
  await bookDueRenewals(workspaceId, todayDateOnly(publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE)).catch((error) =>
    unexpectedResult("bookDueRenewals", error),
  );
}

export async function createAiSubscriptionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("ai-costs", "write");

  const parsed = aiSubscriptionInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  let created: { id: string };
  try {
    created = await createAiSubscription(user.workspace.id, user.id, parsed.data);
  } catch (error) {
    if (error instanceof InvalidSubscriptionError) {
      return rejectedResult(error.field, error.message);
    }
    return unexpectedResult("createAiSubscription", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "ai_subscription.create",
    entityType: "AI_SUBSCRIPTION",
    entityId: created.id,
    outcome: "SUCCESS",
    metadata: { frequency: parsed.data.frequency, currency: parsed.data.currency, seats: parsed.data.seats },
  });
  await bookNow(user.workspace.id);

  refreshPages();
  return { status: "ok", message: "Abonnement enregistré : les renouvellements échus sont inscrits au registre." };
}

export async function cancelAiSubscriptionAction(values: unknown): Promise<ActionResult> {
  const user = await requireModule("ai-costs", "write");

  const parsed = cancelSubscriptionInputSchema.safeParse(values);
  if (!parsed.success) {
    return invalidResult(parsed.error);
  }

  try {
    if (!(await cancelAiSubscription(user.workspace.id, parsed.data.id, parsed.data.cancelledOn))) {
      return rejectedResult("id", "Abonnement introuvable ou déjà résilié.");
    }
  } catch (error) {
    if (error instanceof InvalidSubscriptionError) {
      return rejectedResult(error.field, error.message);
    }
    return unexpectedResult("cancelAiSubscription", error);
  }

  await recordAuditEventSafely({
    workspaceId: user.workspace.id,
    actorId: user.id,
    action: "ai_subscription.cancel",
    entityType: "AI_SUBSCRIPTION",
    entityId: parsed.data.id,
    outcome: "SUCCESS",
  });

  refreshPages();
  return { status: "ok" };
}
