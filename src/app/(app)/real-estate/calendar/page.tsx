import Link from "next/link";
import { Card, PageHeader, inputClass, submitClass } from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { ModuleDisabled } from "@/components/module-disabled";
import { hasModule } from "@/modules/catalog/catalog";
import {
  currentMonthKey,
  formatMonthLabel,
  isValidMonthKey,
  parseMonthKey,
  shiftMonthKey,
  toDateOnlyString,
} from "@/lib/dates";
import {
  buildCalendarEntries,
  buildCalendarMonth,
  CALENDAR_STATUSES,
  CALENDAR_STATUS_LABELS,
  filterCalendarEntries,
  sortCalendarEntries,
  type CalendarStatus,
} from "@/modules/real-estate/calendar";
import {
  listCalendarCashflows,
  listPropertyEvents,
  listPropertyOptions,
} from "@/modules/real-estate/repository";
import { readSearchParam, type SearchParamsInput } from "@/lib/search-params";
import { CalendarEntryList, CalendarMonthGrid } from "./calendar-view";

export const dynamic = "force-dynamic";

type CalendarView = "month" | "list";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500";

/** One button shape for every action of the page, so secondary ones never look like links. */
const SECONDARY_BUTTON = `inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`;
const PRIMARY_BUTTON = `${submitClass} ${FOCUS_RING}`;
const FILTER_LABEL_CLASS =
  "flex w-full flex-col gap-1 text-xs font-medium text-zinc-600 sm:w-52 dark:text-zinc-300";

/** `isValidMonthKey` accepts the format; the calendar also needs a year `monthRange` can read. */
function isSupportedMonthKey(value: string | null | undefined): value is string {
  if (!isValidMonthKey(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));

  return year >= 1970 && year <= 9999;
}

/** A month navigation target, or `null` at the edges of the supported range. */
function safeShiftMonthKey(monthKey: string, months: number): string | null {
  try {
    const shifted = shiftMonthKey(monthKey, months);

    return isSupportedMonthKey(shifted) ? shifted : null;
  } catch {
    return null;
  }
}

function calendarHref({
  view,
  month,
  property,
  status,
}: {
  view: CalendarView;
  month?: string;
  property?: string;
  status?: string;
}): string {
  const params = new URLSearchParams();

  if (view === "list") {
    params.set("view", "list");
  }
  if (month) {
    params.set("month", month);
  }
  if (property) {
    params.set("property", property);
  }
  if (status) {
    params.set("status", status);
  }

  const query = params.toString();

  return query ? `/real-estate/calendar?${query}` : "/real-estate/calendar";
}

export default async function PropertyCalendarPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const params = await searchParams;
  const requestedView: CalendarView =
    readSearchParam(params, "view") === "list" ? "list" : "month";
  const requestedMonth = readSearchParam(params, "month");
  const monthKey =
    requestedMonth && isSupportedMonthKey(requestedMonth)
      ? requestedMonth
      : currentMonthKey();
  const requestedProperty = readSearchParam(params, "property") ?? "";
  const requestedStatusValue = readSearchParam(params, "status");
  const requestedStatus =
    requestedStatusValue &&
    CALENDAR_STATUSES.includes(requestedStatusValue as CalendarStatus)
      ? (requestedStatusValue as CalendarStatus)
      : "";

  const user = await requireUser();
  // A direct link explains the state instead of a 404, and reads nothing of the module.
  if (!hasModule(user.workspace, "real-estate")) {
    return <ModuleDisabled moduleKey="real-estate" workspace={user.workspace} />;
  }

  const [properties, events, cashflows] = await Promise.all([
    listPropertyOptions(user.workspace.id),
    listPropertyEvents(user.workspace.id),
    listCalendarCashflows(user.workspace.id),
  ]);

  // An unknown filter value falls back to "all": a hand-edited link must never fail
  // the page or hide data silently.
  const propertyFilter = properties.some(
    (property) => property.id === requestedProperty,
  )
    ? requestedProperty
    : "";
  const statusFilter = requestedStatus;

  const now = new Date();
  const todayKey = toDateOnlyString(now);
  const currentMonth = currentMonthKey(now);
  const { year, month } = parseMonthKey(monthKey);
  const previousMonth = safeShiftMonthKey(monthKey, -1);
  const nextMonth = safeShiftMonthKey(monthKey, 1);

  const entries = filterCalendarEntries(
    buildCalendarEntries({ events, cashflows, today: now }),
    { propertyId: propertyFilter || null, status: statusFilter || null },
  );
  const monthData = buildCalendarMonth(entries, {
    year,
    month,
    todayKey,
  });
  const listEntries = sortCalendarEntries(entries);

  const filters = { property: propertyFilter, status: statusFilter };
  const viewHref = (view: CalendarView) =>
    calendarHref({ view, month: monthKey, ...filters });
  const monthHref = (targetMonth: string) =>
    calendarHref({ view: "month", month: targetMonth, ...filters });
  const resetHref = calendarHref({
    view: requestedView,
    month: monthKey,
  });

  // The filter controls are uncontrolled, so `defaultValue` only reaches them on mount,
  // while Next.js re-renders this page in place on navigation. Keying the form on the
  // URL state it mirrors remounts it, so « Réinitialiser » never leaves a stale choice.
  const filtersFormKey = `${requestedView}|${monthKey}|${propertyFilter}|${statusFilter}`;

  const hasFilters = Boolean(propertyFilter || statusFilter);
  const undatedCount = listEntries.filter((entry) => entry.dueDate === null).length;
  const emptyDescription = hasFilters
    ? "Aucune échéance ne correspond à ces filtres. Modifiez le bien ou le statut, ou réinitialisez le filtre."
    : "Aucune échéance n'est enregistrée. Ajoutez une échéance depuis la page Immobilier pour la voir apparaître ici.";

  return (
    <>
      <PageHeader
        title="Calendrier immobilier"
        description="Échéances des biens et dates des flux, en vue mensuelle ou en liste."
        actions={
          <Link href="/real-estate" className={SECONDARY_BUTTON}>
            ← Tous les biens
          </Link>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <nav
            aria-label="Vue du calendrier"
            className="inline-flex self-center rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700"
          >
            {(["month", "list"] as const).map((view) => (
              <Link
                key={view}
                href={viewHref(view)}
                aria-current={requestedView === view ? "page" : undefined}
                className={`rounded px-3 py-1 text-sm ${FOCUS_RING} ${
                  requestedView === view
                    ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {view === "month" ? "Mois" : "Liste"}
              </Link>
            ))}
          </nav>

          {requestedView === "month" ? (
            <div className="flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-start">
              {previousMonth ? (
                <Link
                  href={monthHref(previousMonth)}
                  aria-label="Mois précédent"
                  title="Mois précédent"
                  className={`${SECONDARY_BUTTON} px-2`}
                >
                  ‹
                </Link>
              ) : null}
              <span className="whitespace-nowrap px-1 text-center text-sm font-semibold capitalize sm:min-w-36">
                {formatMonthLabel(year, month)}
              </span>
              {nextMonth ? (
                <Link
                  href={monthHref(nextMonth)}
                  aria-label="Mois suivant"
                  title="Mois suivant"
                  className={`${SECONDARY_BUTTON} px-2`}
                >
                  ›
                </Link>
              ) : null}
              {monthKey !== currentMonth ? (
                <Link
                  href={monthHref(currentMonth)}
                  aria-label="Revenir au mois courant"
                  title="Revenir au mois courant"
                  className={`${SECONDARY_BUTTON} ml-1`}
                >
                  <span className="sm:hidden">Auj.</span>
                  <span className="hidden sm:inline">Aujourd&apos;hui</span>
                </Link>
              ) : null}
            </div>
          ) : null}

          <form
            key={filtersFormKey}
            method="get"
            action="/real-estate/calendar"
            className="flex w-full flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 sm:w-auto sm:border-0 sm:pt-0 dark:border-zinc-800"
          >
            <input type="hidden" name="view" value={requestedView} />
            <input type="hidden" name="month" value={monthKey} />

            <label className={FILTER_LABEL_CLASS}>
              <span>Bien</span>
              <select name="property" defaultValue={propertyFilter} className={inputClass}>
                <option value="">Tous les biens</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={`${FILTER_LABEL_CLASS} sm:w-40`}>
              <span>Statut</span>
              <select name="status" defaultValue={statusFilter} className={inputClass}>
                <option value="">Tous les statuts</option>
                {CALENDAR_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {CALENDAR_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex w-full gap-2 sm:w-auto">
              <button type="submit" className={PRIMARY_BUTTON}>
                Filtrer
              </button>
              {hasFilters ? (
                <Link href={resetHref} className={SECONDARY_BUTTON}>
                  Réinitialiser
                </Link>
              ) : null}
            </div>
          </form>

          {requestedView === "list" ? (
            <p className="text-xs text-zinc-500 sm:ml-auto sm:pb-2 dark:text-zinc-400">
              {listEntries.length} entrée(s)
              {undatedCount > 0 ? `, dont ${undatedCount} sans date` : ""}
            </p>
          ) : null}
        </div>
      </Card>

      {requestedView === "month" ? (
        <Card>
          <div className="flex flex-col gap-4">
            <CalendarMonthGrid month={monthData} />

            <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold">Détail du mois</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {monthData.entries.length} entrée(s)
                  {monthData.undatedCount > 0 ? (
                    <>
                      {" · "}
                      {monthData.undatedCount} sans date, en{" "}
                      <Link
                        href={viewHref("list")}
                        className={`rounded underline underline-offset-2 ${FOCUS_RING}`}
                      >
                        vue liste
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              <CalendarEntryList
                entries={monthData.entries}
                emptyTitle="Aucune échéance ce mois-ci"
                emptyDescription={emptyDescription}
              />
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CalendarEntryList
            entries={listEntries}
            emptyTitle="Aucune échéance à afficher"
            emptyDescription={emptyDescription}
          />
        </Card>
      )}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Jours civils groupés en UTC : le fuseau du navigateur ne déplace jamais une
        entrée d&apos;un jour ou d&apos;un mois, et une entrée sans date reste hors du
        calendrier.
      </p>
    </>
  );
}
