"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { deleteInvoiceAction } from "./actions";

/** Removes one invoice and its lines, in two steps like the other deletions. */
export function DeleteInvoiceButton({ invoiceId, label }: { invoiceId: string; label: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function remove(): void {
    startTransition(async () => {
      const outcome = await deleteInvoiceAction({ id: invoiceId });
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
          Supprimer
        </button>
        {result && result.status !== "ok" ? (
          <span className="text-xs text-rose-700 dark:text-rose-400" role="alert">
            {result.message}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <span className="text-xs">Supprimer la facture « {label} » et ses lignes ?</span>
      <span className="flex gap-1">
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="rounded-md bg-rose-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
        >
          {pending ? "Suppression..." : "Confirmer"}
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
    </span>
  );
}
