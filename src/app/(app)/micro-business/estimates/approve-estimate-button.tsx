"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { approveEstimateVersionAction } from "../estimate-actions";

/**
 * Approves one draft version, in two steps.
 *
 * Approval supersedes the project's previous approved version, so the confirmation
 * names the version and the refusal message is shown in place. The action enforces the
 * transition again on the server; an already approved or superseded version is refused
 * there, not only hidden here.
 */
export function ApproveEstimateButton({
  versionId,
  versionNumber,
}: {
  versionId: string;
  versionNumber: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function approve(): void {
    startTransition(async () => {
      const outcome = await approveEstimateVersionAction({ id: versionId });
      setResult(outcome);

      if (outcome.status === "ok") {
        setConfirming(false);
        router.refresh();
      }
    });
  }

  if (!confirming) {
    return (
      <span className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Approuver
        </button>
        {result && result.status !== "ok" ? (
          <span className="max-w-64 text-xs text-rose-700 dark:text-rose-400" role="alert">
            {result.message}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <span className="text-xs">
        Approuver la version {versionNumber} ? La version approuvée précédente sera
        remplacée.
      </span>
      <span className="flex gap-1">
        <button
          type="button"
          onClick={approve}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Approbation..." : "Confirmer"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Annuler
        </button>
      </span>
      {result && result.status !== "ok" ? (
        <span className="max-w-64 text-xs text-rose-700 dark:text-rose-400" role="alert">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
