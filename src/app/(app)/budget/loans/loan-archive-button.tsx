"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { archiveLoanAction, restoreLoanAction } from "./actions";

/**
 * Archives a loan in two steps, or restores it in one.
 *
 * Archiving is reversible and deletes nothing: the row, its links and its history
 * stay, it simply stops appearing in selection forms.
 */
export function LoanArchiveButton({
  loanId,
  label,
  archived,
}: {
  loanId: string;
  label: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function run(archive: boolean): void {
    startTransition(async () => {
      const outcome = archive
        ? await archiveLoanAction({ id: loanId })
        : await restoreLoanAction({ id: loanId });
      setResult(outcome);

      if (outcome.status === "ok") {
        setConfirming(false);
        router.refresh();
      }
    });
  }

  if (archived) {
    return (
      <span className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => run(false)}
          disabled={pending}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {pending ? "Restauration..." : "Restaurer"}
        </button>
        <ErrorLine result={result} />
      </span>
    );
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
          Archiver
        </button>
        <ErrorLine result={result} />
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <span className="text-xs">Archiver le prêt « {label} » ?</span>
      <span className="flex gap-1">
        <button
          type="button"
          onClick={() => run(true)}
          disabled={pending}
          className="rounded-md bg-amber-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
        >
          {pending ? "Archivage..." : "Confirmer"}
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
      <ErrorLine result={result} />
    </span>
  );
}

function ErrorLine({ result }: { result: ActionResult | null }) {
  if (!result || result.status === "ok") {
    return null;
  }

  return (
    <span className="max-w-64 text-xs text-rose-700 dark:text-rose-400" role="alert">
      {result.message}
    </span>
  );
}
