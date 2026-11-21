"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { cancelAiSubscriptionAction } from "./subscription-actions";

const buttonClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

/**
 * Cancels a subscription from a chosen day, in two steps. Renewals before that day stay
 * in the ledger; none is booked from it on.
 */
export function CancelSubscriptionButton({
  subscriptionId,
  label,
  today,
}: {
  subscriptionId: string;
  label: string;
  /** `YYYY-MM-DD`. */
  today: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [cancelledOn, setCancelledOn] = useState(today);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel(): void {
    startTransition(async () => {
      const outcome = await cancelAiSubscriptionAction({ id: subscriptionId, cancelledOn });
      setResult(outcome);
      if (outcome.status === "ok") {
        setConfirming(false);
        router.refresh();
      }
    });
  }

  const error =
    result && result.status !== "ok" ? (
      <span className="max-w-64 text-xs text-rose-700 dark:text-rose-400" role="alert">
        {result.message}
      </span>
    ) : null;

  if (!confirming) {
    return (
      <span className="flex flex-col items-start gap-1">
        <button type="button" onClick={() => setConfirming(true)} className={buttonClass}>
          Résilier
        </button>
        {error}
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <label className="text-xs">
        Résilier « {label} » à partir du
        <input
          type="date"
          value={cancelledOn}
          onChange={(event) => setCancelledOn(event.target.value)}
          className="ml-1 rounded border border-zinc-300 px-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <span className="flex gap-1">
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="rounded-md bg-rose-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
        >
          {pending ? "Résiliation..." : "Confirmer"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={buttonClass}>
          Annuler
        </button>
      </span>
      {error}
    </span>
  );
}
