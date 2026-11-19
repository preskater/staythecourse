import Link from "next/link";
import {
  Card,
  EmptyState,
  Field,
  inputClass,
  submitClass,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { toDateOnlyString } from "@/lib/dates";
import {
  dimensionValueLabel,
  EXPLORER_DIMENSIONS,
  explorerHref,
  FILTER_NONE,
  toEntryDto,
  toGroupDtos,
  totalsByCurrency,
  type ExplorerFilters,
  type ExplorerOptions,
} from "@/modules/ai-costs/explorer";
import { readCostExplorer } from "@/modules/ai-costs/repository";

/**
 * « Explorer » tab of the AI costs page (M12-02).
 *
 * A plain GET form: every view is a URL, so it can be shared, bookmarked and reloaded.
 * Drilling into a group adds its value to the filters; the entries table below always
 * lists the source entries of the current filters.
 */
export async function ExplorerSection({
  workspaceId,
  filters,
  options,
  timeZone,
}: {
  workspaceId: string;
  filters: ExplorerFilters;
  options: ExplorerOptions;
  timeZone: string;
}) {
  const result = await readCostExplorer(workspaceId, filters);
  const groups = toGroupDtos(result.groups, filters);
  const totals = totalsByCurrency(result.groups);
  const entries = result.entries.map((row) => toEntryDto(row, timeZone));
  const groupLabel = EXPLORER_DIMENSIONS.find(({ param }) => param === filters.groupBy)!.label;
  const active = EXPLORER_DIMENSIONS.filter(({ param }) => filters.dimensions[param] !== null);

  return (
    <>
      <Card
        title="Filtres"
        description="Les filtres se combinent (toutes les conditions doivent être vraies). Une entrée est retenue si sa période commence entre les deux dates incluses. Une valeur inconnue dans l'adresse est ignorée."
      >
        <form method="get" action="/ai-costs" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="tab" value="explorer" />
          {EXPLORER_DIMENSIONS.map(({ param, label }) => (
            <Field key={param} label={label} htmlFor={`explorer-${param}`}>
              <select
                id={`explorer-${param}`}
                name={param}
                defaultValue={filters.dimensions[param] ?? ""}
                className={inputClass}
              >
                <option value="">Tous</option>
                <option value={FILTER_NONE}>Non renseigné</option>
                {options[param].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <Field label="Du" htmlFor="explorer-from">
            <input
              id="explorer-from"
              type="date"
              name="from"
              defaultValue={toDateOnlyString(filters.from)}
              className={inputClass}
            />
          </Field>
          <Field label="Au" htmlFor="explorer-to">
            <input
              id="explorer-to"
              type="date"
              name="to"
              defaultValue={toDateOnlyString(filters.to)}
              className={inputClass}
            />
          </Field>
          <Field label="Regrouper par" htmlFor="explorer-by">
            <select id="explorer-by" name="by" defaultValue={filters.groupBy} className={inputClass}>
              {EXPLORER_DIMENSIONS.map(({ param, label }) => (
                <option key={param} value={param}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end gap-2">
            <button type="submit" className={submitClass}>
              Appliquer
            </button>
            <Link href="/ai-costs?tab=explorer" className="text-sm underline">
              Réinitialiser
            </Link>
          </div>
        </form>

        {active.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Filtres actifs">
            {active.map(({ param, label }) => (
              <li key={param}>
                <Link
                  href={explorerHref(filters, { [param]: null })}
                  className="rounded-full bg-zinc-100 px-2 py-0.5 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                  aria-label={`Retirer le filtre ${label}`}
                >
                  {label} : {dimensionValueLabel(filters.dimensions[param])} ×
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card
        title={`Total par ${groupLabel.toLowerCase()}`}
        description={
          totals.length > 0
            ? `Total filtré : ${totals.join(" · ")} (${result.total} entrée(s), sans conversion). Cliquez une ligne pour l'explorer.`
            : undefined
        }
      >
        {groups.length === 0 ? (
          <EmptyState
            title="Aucune entrée pour ces filtres"
            description="Élargissez la période ou retirez un filtre."
          />
        ) : (
          <TableShell caption={`Coûts regroupés par ${groupLabel.toLowerCase()}`}>
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  {groupLabel}
                </th>
                <th scope="col" className={thClass}>
                  Devise
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Entrées
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={`${group.label}-${group.currency}`}>
                  <td className={tdClass}>
                    <Link href={group.href} className="underline">
                      {group.label}
                    </Link>
                  </td>
                  <td className={tdClass}>{group.currency}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{group.amount}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{group.entryCount}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      {entries.length > 0 ? (
        <Card
          title="Entrées sources"
          description={`Page ${result.page} sur ${result.pageCount} — ${result.total} entrée(s), les plus récentes d'abord.`}
        >
          <TableShell caption="Entrées de coût correspondant aux filtres">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Période
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant
                </th>
                <th scope="col" className={thClass}>
                  Fiabilité
                </th>
                <th scope="col" className={thClass}>
                  Source
                </th>
                <th scope="col" className={thClass}>
                  Dimensions
                </th>
                <th scope="col" className={thClass}>
                  État
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className={`${tdClass} whitespace-nowrap`}>{entry.period}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{entry.amount}</td>
                  <td className={tdClass}>{entry.actuality}</td>
                  <td className={tdClass}>
                    {entry.source}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      Capturé le {entry.capturedAt}
                    </span>
                  </td>
                  <td className={`${tdClass} text-xs`}>{entry.dimensions}</td>
                  <td className={tdClass}>{entry.status}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>

          {result.pageCount > 1 ? (
            <nav aria-label="Pagination des entrées" className="mt-3 flex gap-3 text-sm">
              {result.page > 1 ? (
                <Link href={explorerHref(filters, { page: String(result.page - 1) })} className="underline">
                  ← Précédente
                </Link>
              ) : null}
              {result.page < result.pageCount ? (
                <Link href={explorerHref(filters, { page: String(result.page + 1) })} className="underline">
                  Suivante →
                </Link>
              ) : null}
            </nav>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
