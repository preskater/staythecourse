import Link from "next/link";
import {
  Card,
  Notice,
  PageHeader,
  inputClass,
  submitClass,
} from "@/components/ui";
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

  const viewHref = (view: CalendarView) =>
    calendarHref({
      view,
      month: monthKey,
      property: propertyFilter,
      status: statusFilter,
    });
  const monthHref = (targetMonth: string) =>
    calendarHref({
      view: "month",
      month: targetMonth,
      property: propertyFilter,
      status: statusFilter,
    });
  const resetHref = calendarHref({
    view: requestedView,
    month: monthKey,
  });

  const hasFilters = Boolean(propertyFilter || statusFilter);
  const emptyDescription = hasFilters
    ? "Aucune échéance ne correspond à ces filtres. Modifiez le bien ou le statut, ou réinitialisez le filtre."
    : "Aucune échéance n'est enregistrée. Ajoutez une échéance depuis la page Immobilier pour la voir apparaître ici.";

  const viewLinkClass = (view: CalendarView) =>
    view === requestedView
      ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
      : "rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <>
      <PageHeader
        title="Calendrier immobilier"
        description="Échéances des biens et dates des flux, en vue mensuelle ou en liste. Chaque entrée renvoie à son bien."
        actions={
          <Link
            href="/real-estate"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            ← Tous les biens
          </Link>
        }
      />

      <Card
        title="Filtres"
        description="Filtrez par bien et par statut. Les échéances et les flux partagent la même grille de lecture."
      >
        <form
          method="get"
          action="/real-estate/calendar"
          className="flex flex-wrap items-end gap-3 text-sm"
        >
          <input type="hidden" name="view" value={requestedView} />
          <input type="hidden" name="month" value={monthKey} />

          <label className="flex flex-col gap-1">
            <span className="font-medium">Bien</span>
            <select name="property" defaultValue={propertyFilter} className={inputClass}>
              <option value="">Tous les biens</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-medium">Statut</span>
            <select name="status" defaultValue={statusFilter} className={inputClass}>
              <option value="">Tous les statuts</option>
              {CALENDAR_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CALENDAR_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" className={submitClass}>
            Filtrer
          </button>
          <Link href={resetHref} className="text-sm underline">
            Réinitialiser
          </Link>
        </form>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Vue du calendrier" className="flex flex-wrap gap-1">
          <Link
            href={viewHref("month")}
            aria-current={requestedView === "month" ? "page" : undefined}
            className={viewLinkClass("month")}
          >
            Mois
          </Link>
          <Link
            href={viewHref("list")}
            aria-current={requestedView === "list" ? "page" : undefined}
            className={viewLinkClass("list")}
          >
            Liste
          </Link>
        </nav>

        {requestedView === "month" ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {previousMonth ? (
              <Link
                href={monthHref(previousMonth)}
                className="rounded-md border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                ← Précédent
              </Link>
            ) : null}
            <span className="font-medium">{formatMonthLabel(year, month)}</span>
            {nextMonth ? (
              <Link
                href={monthHref(nextMonth)}
                className="rounded-md border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Suivant →
              </Link>
            ) : null}
            {monthKey !== currentMonth ? (
              <Link href={monthHref(currentMonth)} className="underline">
                Ce mois-ci
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Les dates sont des jours civils lus en UTC : le fuseau du navigateur ne déplace
        jamais une échéance d&apos;un jour ou d&apos;un mois. Une entrée sans date
        n&apos;est jamais placée dans un mois : elle apparaît uniquement en vue liste.
      </p>

      {requestedView === "month" ? (
        <Card
          title="Vue mensuelle"
          description="La grille donne le rythme du mois ; le détail sous la grille reste lisible sur un téléphone."
        >
          <div className="flex flex-col gap-4">
            <CalendarMonthGrid month={monthData} />

            {monthData.undatedCount > 0 ? (
              <Notice tone="info">
                {monthData.undatedCount} entrée(s) sans date, visible(s) uniquement en
                vue liste.{" "}
                <Link href={viewHref("list")} className="underline">
                  Voir la liste complète
                </Link>
                .
              </Notice>
            ) : null}

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Détail du mois
              </h2>
              <CalendarEntryList
                entries={monthData.entries}
                emptyTitle="Aucune échéance ce mois-ci"
                emptyDescription={emptyDescription}
              />
            </div>
          </div>
        </Card>
      ) : (
        <Card
          title="Toutes les échéances"
          description="Les entrées datées sont classées chronologiquement ; celles sans date sont regroupées en fin de liste."
        >
          <CalendarEntryList
            entries={listEntries}
            emptyTitle="Aucune échéance à afficher"
            emptyDescription={emptyDescription}
          />
        </Card>
      )}
    </>
  );
}
