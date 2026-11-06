"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { setClientArchivedAction, setProjectArchivedAction } from "./actions";

/**
 * Archives or restores one record.
 *
 * No confirmation step: archiving is reversible and keeps every field, so it replaces
 * the deletion a manager might expect without any risk of losing data. The label names
 * the record, which is what makes the click unambiguous in a long table.
 */
export function ArchiveToggle({
  kind,
  id,
  label,
  archived,
}: {
  kind: "client" | "project";
  id: string;
  label: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(): void {
    startTransition(async () => {
      const payload = { id, archived: archived ? "false" : "true" };
      const outcome =
        kind === "client"
          ? await setClientArchivedAction(payload)
          : await setProjectArchivedAction(payload);

      setResult(outcome);
      if (outcome.status === "ok") {
        setResult(null);
        router.refresh();
      }
    });
  }

  const verb = archived ? "Restaurer" : "Archiver";

  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-label={`${verb} « ${label} »`}
        className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {pending ? (archived ? "Restauration..." : "Archivage...") : verb}
      </button>
      {result && result.status !== "ok" ? (
        <span className="max-w-64 text-xs text-rose-700 dark:text-rose-400" role="alert">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
