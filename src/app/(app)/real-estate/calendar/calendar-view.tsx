import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui";
import {
  CALENDAR_SOURCE_LABELS,
  type CalendarEntry,
  type CalendarMonth,
} from "@/modules/real-estate/calendar";
import {
  PROPERTY_EVENT_DUE_STATE_LABELS,
  type PropertyEventDueState,
} from "@/modules/real-estate/events";

const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const DUE_STATE_TONES: Record<
  PropertyEventDueState,
  "neutral" | "positive" | "negative" | "warning"
> = {
  OVERDUE: "negative",
  DUE_TODAY: "warning",
  UPCOMING: "neutral",
  DONE: "positive",
  CANCELLED: "neutral",
  NO_DATE: "neutral",
};

/** Cell chips carry the status as a left rule, so a month reads at a glance. */
const CHIP_TONES: Record<PropertyEventDueState, string> = {
  OVERDUE:
    "border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-500 dark:bg-rose-950/50 dark:text-rose-100",
  DUE_TODAY:
    "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-500 dark:bg-amber-950/50 dark:text-amber-100",
  UPCOMING:
    "border-sky-400 bg-sky-50 text-zinc-900 dark:border-sky-500 dark:bg-sky-950/40 dark:text-zinc-100",
  DONE:
    "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/50 dark:text-emerald-100",
  CANCELLED:
    "border-zinc-300 bg-zinc-100 text-zinc-500 line-through dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  NO_DATE: "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500";

/** Day and short month, always read in UTC so a calendar day never shifts. */
const MONTH_LABEL = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "short" });
const DAY_LABEL = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit" });

function dateParts(date: Date): { month: string; day: string } {
  return {
    month: MONTH_LABEL.format(date).replace(".", ""),
    day: DAY_LABEL.format(date),
  };
}

function EntryRow({ entry }: { entry: CalendarEntry }) {
  const parts = entry.dueDate ? dateParts(entry.dueDate) : null;

  return (
    <li className="flex items-start gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div
        className={`w-9 shrink-0 rounded-md py-1 text-center ${
          parts ? "bg-zinc-100 dark:bg-zinc-800" : "border border-dashed border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {parts ? parts.month : "—"}
        </span>
        <span className="block text-sm font-semibold tabular-nums">
          {parts ? parts.day : "—"}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <p className="min-w-0 font-medium break-words">{entry.label}</p>
          <Badge tone={DUE_STATE_TONES[entry.dueState]}>
            {PROPERTY_EVENT_DUE_STATE_LABELS[entry.dueState]}
          </Badge>
        </div>

        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            {CALENDAR_SOURCE_LABELS[entry.source]} · {entry.kindLabel}
          </span>
          <span aria-hidden>·</span>
          <Link
            href={`/real-estate/${entry.propertyId}`}
            className={`rounded underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200 ${FOCUS_RING}`}
          >
            {entry.propertyName}
          </Link>
        </p>
      </div>
    </li>
  );
}

/**
 * The readable list of entries.
 *
 * It stays a plain list rather than a table so a phone can read it without horizontal
 * scrolling; every row names its property, and the property name is the link to the
 * property page. Undated entries are grouped last, never between two dated ones.
 */
export function CalendarEntryList({
  entries,
  emptyTitle,
  emptyDescription,
}: {
  entries: readonly CalendarEntry[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (entries.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const dated = entries.filter((entry) => entry.dueDate !== null);
  const undated = entries.filter((entry) => entry.dueDate === null);

  return (
    <ul className="flex flex-col gap-2">
      {dated.map((entry) => (
        <EntryRow key={entry.id} entry={entry} />
      ))}

      {undated.length > 0 ? (
        <>
          <li className="pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Sans date
          </li>
          {undated.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </>
      ) : null}
    </ul>
  );
}

/**
 * The month grid.
 *
 * From `md` up a cell lists its first two labels; on a phone it shows only the number of
 * entries, because seven columns of text are unreadable at that width. The full detail is
 * the list under the grid, which is where a phone reads the month.
 *
 * A padding cell outside the month carries no date and stays out of the accessibility
 * tree: it belongs to the layout, not to the month.
 */
export function CalendarMonthGrid({ month }: { month: CalendarMonth }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label}>{label}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {month.cells.map((cell, index) => {
          if (cell.date === null) {
            return <div key={`blank-${index}`} aria-hidden className="min-h-14 md:min-h-20" />;
          }

          const count = cell.entries.length;
          const visible = cell.entries.slice(0, 2);

          return (
            <div
              key={cell.date}
              className={`min-h-14 rounded-md border p-1.5 md:min-h-20 ${
                count > 0
                  ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                  : "border-zinc-100 bg-zinc-50/60 dark:border-zinc-800/60 dark:bg-zinc-900/30"
              } ${cell.isToday ? "border-sky-300 ring-1 ring-sky-500 dark:border-sky-800 dark:ring-sky-400" : ""}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span
                  className={`text-[11px] font-semibold tabular-nums ${
                    cell.isToday
                      ? "text-sky-700 dark:text-sky-300"
                      : "text-zinc-600 dark:text-zinc-300"
                  }`}
                >
                  {cell.day}
                </span>
                {count > 0 ? (
                  <span
                    className="rounded-full bg-zinc-900 px-1.5 text-[10px] font-semibold leading-4 text-white md:hidden dark:bg-zinc-100 dark:text-zinc-900"
                    aria-label={`${count} entrée(s)`}
                  >
                    {count}
                  </span>
                ) : null}
              </div>

              {count > 0 ? (
                <ul className="mt-1 hidden flex-col gap-1 md:flex">
                  {visible.map((entry) => (
                    <li key={entry.id} className="min-w-0">
                      <Link
                        href={`/real-estate/${entry.propertyId}`}
                        title={`${entry.propertyName} — ${entry.label} (${PROPERTY_EVENT_DUE_STATE_LABELS[entry.dueState]})`}
                        className={`block truncate rounded-sm border-l-2 px-1.5 py-0.5 text-[11px] leading-tight hover:brightness-95 ${CHIP_TONES[entry.dueState]} ${FOCUS_RING}`}
                      >
                        {entry.label}
                      </Link>
                    </li>
                  ))}
                  {count > visible.length ? (
                    <li className="pl-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                      +{count - visible.length} autre(s)
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
