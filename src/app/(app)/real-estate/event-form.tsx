"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, Notice, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  PROPERTY_EVENT_KINDS,
  PROPERTY_EVENT_KIND_LABELS,
  PROPERTY_EVENT_STATUSES,
  PROPERTY_EVENT_STATUS_LABELS,
  propertyEventInputSchema,
  type PropertyEventFormValues,
  type PropertyEventInput,
  type PropertyEventKind,
  type PropertyEventStatus,
} from "@/modules/real-estate/events";
import { createPropertyEventAction, updatePropertyEventAction } from "./actions";

export type PropertyEventPropertyOption = {
  id: string;
  name: string;
  /** Reference currency of the property, used as the amount's default. */
  currency: string;
};

/** Form defaults for a create (empty) or an edit (the event's strings), never the id. */
function formDefaults(
  properties: PropertyEventPropertyOption[],
  event?: PropertyEventFormValues | null,
): Omit<PropertyEventInput, "id"> {
  const first = properties[0];

  if (event) {
    const eventProperty = properties.find((property) => property.id === event.propertyId);

    return {
      propertyId: event.propertyId,
      kind: event.kind,
      label: event.label,
      dueDate: event.dueDate,
      status: event.status,
      amount: event.amount,
      // An event without an amount has no stored currency: start from the property's.
      currency: event.amount === "" ? eventProperty?.currency ?? "EUR" : event.currency,
      notes: event.notes,
    };
  }

  return {
    propertyId: first?.id ?? "",
    kind: "TAX",
    label: "",
    dueDate: "",
    status: "PLANNED",
    amount: "",
    currency: first?.currency ?? "EUR",
    notes: "",
  };
}

/**
 * Creates or edits a property event.
 *
 * The optional amount is explicitly informational: saving an event never creates a
 * transaction. An event without a date stays "sans date" and never becomes overdue.
 */
export function PropertyEventForm({
  properties,
  event,
}: {
  properties: PropertyEventPropertyOption[];
  event?: PropertyEventFormValues | null;
}) {
  const form = useForm<PropertyEventInput>({
    resolver: zodResolver(propertyEventInputSchema, undefined, { raw: true }),
    defaultValues: formDefaults(properties, event),
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    event?.id
      ? updatePropertyEventAction({ ...values, id: event.id })
      : createPropertyEventAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  if (properties.length === 0) {
    return (
      <Notice tone="warning">
        Aucun bien n&apos;est enregistré. Ajoutez un bien avant de saisir une échéance.
      </Notice>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field label="Bien" htmlFor="event-property" error={errors.propertyId?.message}>
        <select
          id="event-property"
          className={inputClass}
          {...form.register("propertyId", {
            onChange: (change) => {
              const selected = properties.find(
                (property) => property.id === change.target.value,
              );
              if (selected) {
                form.setValue("currency", selected.currency);
              }
            },
          })}
        >
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Nature" htmlFor="event-kind" error={errors.kind?.message}>
        <select id="event-kind" className={inputClass} {...form.register("kind")}>
          {PROPERTY_EVENT_KINDS.map((kind: PropertyEventKind) => (
            <option key={kind} value={kind}>
              {PROPERTY_EVENT_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Libellé"
        htmlFor="event-label"
        error={errors.label?.message}
        hint="Par exemple : taxe foncière 2026, renouvellement du bail."
      >
        <input
          id="event-label"
          className={inputClass}
          autoComplete="off"
          {...form.register("label")}
        />
      </Field>

      <Field
        label="Échéance"
        htmlFor="event-due-date"
        error={errors.dueDate?.message}
        hint="Facultatif : sans date, l'échéance reste « sans date » et n'est jamais en retard."
      >
        <input
          id="event-due-date"
          type="date"
          className={inputClass}
          {...form.register("dueDate")}
        />
      </Field>

      <Field
        label="Statut"
        htmlFor="event-status"
        error={errors.status?.message}
        hint="Une échéance terminée ou annulée n'est jamais en retard."
      >
        <select id="event-status" className={inputClass} {...form.register("status")}>
          {PROPERTY_EVENT_STATUSES.map((status: PropertyEventStatus) => (
            <option key={status} value={status}>
              {PROPERTY_EVENT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Montant indicatif"
        htmlFor="event-amount"
        error={errors.amount?.message}
        hint="Facultatif et informatif : il n'entre dans aucun total et ne crée aucune transaction."
      >
        <input
          id="event-amount"
          className={inputClass}
          inputMode="decimal"
          placeholder="1200,00"
          autoComplete="off"
          {...form.register("amount")}
        />
      </Field>

      <Field label="Devise du montant" htmlFor="event-currency" error={errors.currency?.message}>
        <select id="event-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Notes" htmlFor="event-notes" error={errors.notes?.message}>
        <textarea id="event-notes" rows={2} className={inputClass} {...form.register("notes")} />
      </Field>

      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton
          label={event?.id ? "Enregistrer les modifications" : "Ajouter l'échéance"}
          pending={isSubmitting}
        />
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <FormFeedback
          result={result}
          successMessage={event?.id ? "Échéance mise à jour." : "Échéance enregistrée."}
        />
      </div>
    </form>
  );
}
