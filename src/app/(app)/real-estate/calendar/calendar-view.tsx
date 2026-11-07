import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui";
import { formatDateOnly } from "@/lib/dates";
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

function EntryRow({ entry }: { entry: CalendarEntry }) {
  return (
    <li className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{entry.label}</span>
        <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {entry.dueDate ? formatDateOnly(entry.dueDate) : "sans date"}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <Badge tone="neutral">{CALENDAR_SOURCE_LABELS[entry.source]}</Badge>
        <span>{entry.kindLabel}</span>
        <span aria-hidden>·</span>
        <Link href={`/real-estate/${entry.propertyId}`} className="underline">
          {entry.propertyName}
        </Link>
        <Badge tone={DUE_STATE_TONES[entry.dueState]}>
          {PROPERTY_EVENT_DUE_STATE_LABELS[entry.dueState]}
        </Badge>
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
 * A cell shows its day and the number of entries; from `md` up it also shows the first
 * two labels. The full detail is the list below the grid, which is what keeps the
 * seven-column layout readable on a phone. A padding cell outside the month has no date
 * and is hidden from assistive technology.
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
            return (
              <div
                key={`blank-${index}`}
                aria-hidden
                className="min-h-16 rounded-md bg-zinc-50 sm:min-h-20 dark:bg-zinc-900/40"
              />
            );
          }

          const count = cell.entries.length;
          const visible = cell.entries.slice(0, 2);

          return (
            <div
              key={cell.date}
              className={`min-h-16 rounded-md border p-1 sm:min-h-20 ${
                cell.isToday ? "ring-2 ring-sky-400" : ""
              } ${
                count > 0
                  ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                  : "border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/30"
              }`}
            >
              <div
                className={`text-xs font-medium tabular-nums ${
                  cell.isToday ? "text-sky-700 dark:text-sky-300" : ""
                }`}
              >
                {cell.day}
              </div>

              {count > 0 ? (
                <>
                  <span
                    title={`${count} entrée(s)`}
                    className="mt-1 inline-flex rounded-full bg-zinc-900 px-1.5 text-[10px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {count}
                  </span>

                  <ul className="mt-1 hidden flex-col gap-0.5 md:flex">
                    {visible.map((entry) => (
                      <li key={entry.id} className="truncate text-[11px]">
                        <Link
                          href={`/real-estate/${entry.propertyId}`}
                          title={`${entry.propertyName} — ${entry.label}`}
                          className="block truncate underline-offset-2 hover:underline"
                        >
                          {entry.label}
                        </Link>
                      </li>
                    ))}
                    {count > visible.length ? (
                      <li className="text-[10px] text-zinc-500 dark:text-zinc-400">
                        +{count - visible.length}
                      </li>
                    ) : null}
                  </ul>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
