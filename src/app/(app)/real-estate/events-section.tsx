import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  StatCard,
  TableShell,
  inputClass,
  submitClass,
  tdClass,
  thClass,
} from "@/components/ui";
import { formatDateOnly } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  PROPERTY_EVENT_DUE_STATE_LABELS,
  PROPERTY_EVENT_KIND_LABELS,
  PROPERTY_EVENT_STATUSES,
  PROPERTY_EVENT_STATUS_LABELS,
  propertyEventDueState,
  summarizePropertyEvents,
  type PropertyEvent,
  type PropertyEventDueState,
  type PropertyEventFormValues,
  type PropertyEventStatus,
} from "@/modules/real-estate/events";
import { PropertyEventForm, type PropertyEventPropertyOption } from "./event-form";
import { DeleteEventButton } from "./delete-event-button";

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

export type PropertyEventFilterValues = {
  propertyId: string;
  status: string;
};

/**
 * Property events, with the optional property/status filters.
 *
 * The due state is computed server-side from the calendar day, so an undated event is
 * never shown as late. The amount column is labelled "indicatif": it is never added
 * to a property total, and saving an event never creates a transaction.
 */
export function PropertyEventsSection({
  title,
  properties,
  events,
  today,
  editEvent,
  filter,
  basePath,
}: {
  title: string;
  properties: PropertyEventPropertyOption[];
  events: PropertyEvent[];
  today: Date;
  editEvent: PropertyEventFormValues | null;
  /** When set, the page offers the property and status filters. */
  filter?: PropertyEventFilterValues;
  /** Page the edit link returns to; the filter is preserved. */
  basePath: string;
}) {
  const summary = summarizePropertyEvents(events, today);
  const propertyNameById = new Map(
    properties.map((property) => [property.id, property.name]),
  );

  function editHref(eventId: string): string {
    const params = new URLSearchParams({ editEvent: eventId });

    if (filter?.propertyId) {
      params.set("eventProperty", filter.propertyId);
    }

    if (filter?.status) {
      params.set("eventStatus", filter.status);
    }

    return `${basePath}?${params.toString()}`;
  }

  function resetHref(): string {
    return basePath;
  }

  return (
    <Card
      title={title}
      description="Taxes, assurances, entretien, baux, contrôles, échéances de prêt et travaux. Une échéance est un rappel, pas une écriture comptable : son montant reste indicatif, n'entre dans aucun total et ne crée aucune transaction. Sans date, une échéance n'est jamais en retard ; terminée ou annulée non plus."
    >
      <div className="flex flex-col gap-4">
        {filter ? (
          <form
            method="get"
            action={basePath}
            className="flex flex-wrap items-end gap-3 text-sm"
          >
            <label className="flex flex-col gap-1">
              <span className="font-medium">Bien</span>
              <select name="eventProperty" defaultValue={filter.propertyId} className={inputClass}>
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
              <select name="eventStatus" defaultValue={filter.status} className={inputClass}>
                <option value="">Tous les statuts</option>
                {PROPERTY_EVENT_STATUSES.map((status: PropertyEventStatus) => (
                  <option key={status} value={status}>
                    {PROPERTY_EVENT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className={submitClass}>
              Filtrer
            </button>
            <Link href={resetHref()} className="text-sm underline">
              Réinitialiser
            </Link>
          </form>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="En retard"
            value={String(summary.overdue)}
            tone={summary.overdue > 0 ? "negative" : "neutral"}
            hint={`${summary.done} terminée(s), ${summary.cancelled} annulée(s)`}
          />
          <StatCard label="À échéance aujourd'hui" value={String(summary.dueToday)} />
          <StatCard label="À venir" value={String(summary.upcoming)} />
          <StatCard
            label="Sans date"
            value={String(summary.withoutDate)}
            hint="Jamais en retard : aucune date n'est inventée."
          />
        </div>

        <details open={Boolean(editEvent)}>
          <summary className="cursor-pointer text-sm font-medium">
            {editEvent ? `Modifier l'échéance « ${editEvent.label} »` : "Nouvelle échéance"}
          </summary>
          <div className="pt-3">
            {editEvent ? (
              <p className="mb-2 text-xs">
                <Link href={resetHref()} className="underline">
                  Annuler la modification
                </Link>
              </p>
            ) : null}
            <PropertyEventForm
              key={editEvent?.id ?? "new"}
              properties={properties}
              event={editEvent}
            />
          </div>
        </details>

        {events.length === 0 ? (
          <EmptyState
            title="Aucune échéance à afficher"
            description={
              filter?.propertyId || filter?.status
                ? "Aucune échéance ne correspond à ces filtres. Modifiez le bien ou le statut, ou réinitialisez le filtre."
                : "Aucune échéance n'est enregistrée. Ajoutez une taxe, une assurance ou un contrôle pour suivre ses dates."
            }
          />
        ) : (
          <TableShell caption="Échéances des biens">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Échéance
                </th>
                <th scope="col" className={thClass}>
                  Bien
                </th>
                <th scope="col" className={thClass}>
                  Nature
                </th>
                <th scope="col" className={thClass}>
                  Libellé
                </th>
                <th scope="col" className={thClass}>
                  État
                </th>
                <th scope="col" className={thClass}>
                  Statut
                </th>
                <th scope="col" className={`${thClass} text-right`}>
                  Montant indicatif
                </th>
                <th scope="col" className={thClass}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const state = propertyEventDueState(event, today);

                return (
                  <tr key={event.id}>
                    <td className={`${tdClass} whitespace-nowrap`}>
                      {event.dueDate ? formatDateOnly(event.dueDate) : "sans date"}
                    </td>
                    <td className={tdClass}>
                      {propertyNameById.get(event.propertyId) ?? event.propertyName}
                    </td>
                    <td className={tdClass}>{PROPERTY_EVENT_KIND_LABELS[event.kind]}</td>
                    <td className={tdClass}>
                      <span className="font-medium">{event.label}</span>
                      {event.notes ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {event.notes}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <Badge tone={DUE_STATE_TONES[state]}>
                        {PROPERTY_EVENT_DUE_STATE_LABELS[state]}
                      </Badge>
                    </td>
                    <td className={tdClass}>{PROPERTY_EVENT_STATUS_LABELS[event.status]}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>
                      {event.amount === null
                        ? "—"
                        : formatMoney({
                            amount: event.amount,
                            currency: event.currency ?? "EUR",
                          })}
                    </td>
                    <td className={tdClass}>
                      <span className="flex flex-col items-start gap-1">
                        <Link
                          href={editHref(event.id)}
                          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Modifier
                        </Link>
                        <DeleteEventButton eventId={event.id} label={event.label} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </div>
    </Card>
  );
}
