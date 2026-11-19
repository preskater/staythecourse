"use client";

import { useState, useTransition } from "react";
import { Badge, Notice, TableShell, inputClass, submitClass, tdClass, thClass } from "@/components/ui";
import {
  INBOX_BULK_LIMIT,
  INBOX_ENTRY_STATE_LABELS,
  type InboxActionResult,
  type InboxEntryState,
} from "@/modules/ai-costs/inbox";
import { applyPolicyToEntriesAction, finalizeEntriesAction } from "./actions";

/**
 * Inbox table: selection, policy preview, apply, finalize.
 *
 * Plain serialised props only (strings): amounts are formatted on the server. Any
 * change of selection, policy or values discards the preview, so "Appliquer" always
 * applies what was just previewed. Finalization asks for a second click.
 */

export type InboxRow = {
  id: string;
  period: string;
  label: string;
  source: string;
  known: string;
  total: string;
  allocated: string;
  unallocated: string;
  state: InboxEntryState;
};

export type InboxPolicyOption = {
  id: string;
  name: string;
  version: number;
  /** Set when the policy needs one value per target (seats, usage, amounts). */
  measureLabel: string | null;
  targets: string[];
};

const STATE_TONE: Record<InboxEntryState, "negative" | "warning" | "positive"> = {
  UNALLOCATED: "negative",
  PARTIAL: "warning",
  ALLOCATED: "positive",
};

export function InboxTable({
  rows,
  policies,
  canManage,
}: {
  rows: InboxRow[];
  policies: InboxPolicyOption[];
  canManage: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const [measures, setMeasures] = useState<string[]>([]);
  const [preview, setPreview] = useState<InboxActionResult | null>(null);
  const [result, setResult] = useState<InboxActionResult | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [isPending, startTransition] = useTransition();

  const policy = policies.find((candidate) => candidate.id === policyId) ?? null;
  const needsMeasures = policy?.measureLabel != null;
  const ids = [...selected];
  const outcomes = new Map(
    [preview, result].flatMap((item) => (item?.status === "ok" ? item.outcomes : [])).map((outcome) => [outcome.entryId, outcome]),
  );
  const canPreview =
    canManage && policy !== null && ids.length > 0 && !isPending && (!needsMeasures || ids.length === 1);

  function reset() {
    setPreview(null);
    setConfirmFinalize(false);
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < INBOX_BULK_LIMIT) next.add(id);
    setSelected(next);
    setResult(null);
    reset();
  }

  function toggleAll() {
    setSelected(selected.size > 0 ? new Set() : new Set(rows.slice(0, INBOX_BULK_LIMIT).map((row) => row.id)));
    setResult(null);
    reset();
  }

  function run(dryRun: boolean) {
    if (!canPreview || policy === null) return;
    startTransition(async () => {
      const outcome = await applyPolicyToEntriesAction({
        entryIds: ids,
        policyId: policy.id,
        measures: needsMeasures ? policy.targets.map((_, index) => measures[index] ?? "") : null,
        dryRun,
      });
      if (dryRun) {
        setPreview(outcome);
        setResult(null);
      } else {
        setPreview(null);
        setResult(outcome);
        setSelected(new Set());
      }
    });
  }

  function finalize() {
    if (!confirmFinalize) {
      setConfirmFinalize(true);
      return;
    }
    startTransition(async () => {
      setResult(await finalizeEntriesAction({ entryIds: ids }));
      setSelected(new Set());
      reset();
    });
  }

  const previewReady = preview?.status === "ok" && preview.outcomes.some((outcome) => outcome.ok);

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Politique de répartition</span>
              <select
                className={inputClass}
                value={policyId}
                onChange={(event) => {
                  setPolicyId(event.target.value);
                  setMeasures([]);
                  reset();
                }}
              >
                {policies.length === 0 ? <option value="">Aucune politique active</option> : null}
                {policies.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} (v{candidate.version})
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {ids.length} coût{ids.length > 1 ? "s" : ""} sélectionné{ids.length > 1 ? "s" : ""} (au plus {INBOX_BULK_LIMIT}).
              {policy ? ` Cibles : ${policy.targets.join(" ; ")}.` : ""}
            </p>
          </div>

          {policy && needsMeasures ? (
            ids.length === 1 ? (
              <div className="grid gap-2 sm:grid-cols-3">
                {policy.targets.map((target, index) => (
                  <label key={target} className="flex flex-col gap-1 text-sm">
                    <span>
                      {policy.measureLabel} — {target}
                    </span>
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      value={measures[index] ?? ""}
                      onChange={(event) => {
                        const next = [...measures];
                        next[index] = event.target.value;
                        setMeasures(next);
                        reset();
                      }}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <Notice tone="info">
                Cette politique demande une valeur par cible ({policy.measureLabel?.toLowerCase()}) : sélectionnez un seul coût.
              </Notice>
            )
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={submitClass} disabled={!canPreview} onClick={() => run(true)}>
              {isPending ? "Calcul..." : "Prévisualiser"}
            </button>
            <button type="button" className={submitClass} disabled={!canPreview || !previewReady} onClick={() => run(false)}>
              Appliquer la répartition
            </button>
            <button
              type="button"
              className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-800 disabled:opacity-60 dark:border-rose-800 dark:text-rose-200"
              disabled={ids.length === 0 || isPending}
              onClick={finalize}
            >
              {confirmFinalize ? `Confirmer la validation de ${ids.length} coût(s)` : "Valider la sélection"}
            </button>
          </div>
          {confirmFinalize ? (
            <Notice tone="warning">
              Un coût validé ne peut plus être réparti ni modifié. Cliquez à nouveau pour confirmer.
            </Notice>
          ) : null}
        </div>
      ) : null}

      {[preview, result].map((item, index) =>
        item ? (
          <Notice key={index} tone={item.status === "ok" ? "info" : "error"}>
            {item.message}
          </Notice>
        ) : null,
      )}

      <TableShell caption="Coûts en brouillon">
        <thead>
          <tr>
            {canManage ? (
              <th scope="col" className={thClass}>
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={selected.size > 0}
                  onChange={toggleAll}
                />
              </th>
            ) : null}
            <th scope="col" className={thClass}>Période</th>
            <th scope="col" className={thClass}>Coût</th>
            <th scope="col" className={`${thClass} text-right`}>Montant</th>
            <th scope="col" className={`${thClass} text-right`}>Non réparti</th>
            <th scope="col" className={thClass}>État</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const outcome = outcomes.get(row.id);
            return (
              <tr key={row.id}>
                {canManage ? (
                  <td className={tdClass}>
                    <input
                      type="checkbox"
                      aria-label={`Sélectionner ${row.label}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </td>
                ) : null}
                <td className={`${tdClass} whitespace-nowrap tabular-nums`}>{row.period}</td>
                <td className={tdClass}>
                  <span className="font-medium">{row.label}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {row.source}
                    {row.known !== "—" ? ` · ${row.known}` : ""}
                  </span>
                </td>
                <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>{row.total}</td>
                <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>
                  {row.unallocated}
                  <span className="block text-xs text-zinc-500">réparti {row.allocated}</span>
                </td>
                <td className={tdClass}>
                  <Badge tone={STATE_TONE[row.state]}>{INBOX_ENTRY_STATE_LABELS[row.state]}</Badge>
                  {outcome ? (
                    <span className="mt-1 block text-xs">
                      {outcome.ok
                        ? outcome.planned.length > 0
                          ? outcome.planned.map((planned) => `${planned.dimensions} : ${planned.amount}`).join(" ; ")
                          : "OK"
                        : outcome.reason}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableShell>
    </div>
  );
}
