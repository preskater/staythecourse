"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  PROPERTY_OCCUPANCIES,
  PROPERTY_OCCUPANCY_LABELS as OCCUPANCY_LABELS,
  propertyInputSchema,
  type PropertyInput,
  type PropertyOccupancy,
} from "@/modules/real-estate/domain";
import { createPropertyAction, updatePropertyAction } from "./actions";

/** String-only initial values for the edit form: a client never receives a Decimal. */
export type PropertyFormValues = {
  id: string;
  name: string;
  address: string;
  occupancy: string;
  currency: string;
  purchaseDate: string;
  purchasePrice: string;
  estimatedValue: string;
  estimatedValueAsOf: string;
  targetGainRate: string;
  notes: string;
};

const EMPTY: Omit<PropertyFormValues, "id"> = {
  name: "",
  address: "",
  occupancy: "VACANT",
  currency: "EUR",
  purchaseDate: "",
  purchasePrice: "",
  estimatedValue: "",
  estimatedValueAsOf: "",
  targetGainRate: "10",
  notes: "",
};

/** Form defaults for a creation (empty) or an edition (the property's strings). */
function formDefaults(property?: PropertyFormValues | null): PropertyInput {
  const values = property ?? EMPTY;

  return {
    name: values.name,
    address: values.address,
    occupancy: values.occupancy as PropertyOccupancy,
    currency: values.currency,
    purchaseDate: values.purchaseDate,
    purchasePrice: values.purchasePrice,
    estimatedValue: values.estimatedValue,
    estimatedValueAsOf: values.estimatedValueAsOf,
    targetGainRate: values.targetGainRate,
    notes: values.notes,
  };
}

/**
 * Creates or edits a property.
 *
 * Occupancy is asked for explicitly rather than assumed: a property is not
 * necessarily rented (see AGENTS.md). Prices are optional and read "inconnu" when
 * left empty — never zero. The sale itself is not part of this form: it is recorded
 * through the dedicated sale panel, which validates date, price and costs together.
 */
export function PropertyForm({ property }: { property?: PropertyFormValues | null }) {
  const editing = Boolean(property?.id);

  const form = useForm<PropertyInput>({
    resolver: zodResolver(propertyInputSchema, undefined, { raw: true }),
    defaultValues: formDefaults(property),
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    property?.id
      ? updatePropertyAction({ ...values, id: property.id })
      : createPropertyAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  // `defaultValues` are read once, on mount: adopting a refreshed property (or
  // switching target) requires an explicit reset. The page keys this component by id.
  useEffect(() => {
    form.reset(formDefaults(property));
  }, [property, form]);

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field label="Nom du bien" htmlFor="property-name" error={errors.name?.message}>
        <input
          id="property-name"
          className={inputClass}
          autoComplete="off"
          {...form.register("name")}
        />
      </Field>

      <Field label="Occupation" htmlFor="property-occupancy" error={errors.occupancy?.message}>
        <select
          id="property-occupancy"
          className={inputClass}
          {...form.register("occupancy")}
        >
          {PROPERTY_OCCUPANCIES.map((occupancy) => (
            <option key={occupancy} value={occupancy}>
              {OCCUPANCY_LABELS[occupancy]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Devise des prix"
        htmlFor="property-currency"
        error={errors.currency?.message}
        hint="Acquisition, estimation et cession. Les flux gardent leur propre devise."
      >
        <select id="property-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Adresse"
        htmlFor="property-address"
        error={errors.address?.message}
        hint="Facultatif : une adresse n'est pas nécessaire pour suivre un bien."
      >
        <input
          id="property-address"
          className={inputClass}
          autoComplete="off"
          {...form.register("address")}
        />
      </Field>

      <Field
        label="Date d'acquisition"
        htmlFor="property-purchase-date"
        error={errors.purchaseDate?.message}
      >
        <input
          id="property-purchase-date"
          type="date"
          className={inputClass}
          {...form.register("purchaseDate")}
        />
      </Field>

      <Field
        label="Prix d'acquisition"
        htmlFor="property-purchase-price"
        error={errors.purchasePrice?.message}
        hint="Facultatif : vide reste « inconnu », jamais zéro."
      >
        <input
          id="property-purchase-price"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          {...form.register("purchasePrice")}
        />
      </Field>

      <Field
        label="Valeur estimée"
        htmlFor="property-estimated-value"
        error={errors.estimatedValue?.message}
        hint="Dernière estimation connue, datée ci-contre."
      >
        <input
          id="property-estimated-value"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          {...form.register("estimatedValue")}
        />
      </Field>

      <Field
        label="Estimation au"
        htmlFor="property-estimated-value-as-of"
        error={errors.estimatedValueAsOf?.message}
        hint="Le montant et sa date vont ensemble."
      >
        <input
          id="property-estimated-value-as-of"
          type="date"
          className={inputClass}
          {...form.register("estimatedValueAsOf")}
        />
      </Field>

      <Field
        label="Objectif de plus-value (%)"
        htmlFor="property-target-gain-rate"
        error={errors.targetGainRate?.message}
        hint="Marge visée au-dessus du seuil de cession sans perte."
      >
        <input
          id="property-target-gain-rate"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          {...form.register("targetGainRate")}
        />
      </Field>

      <Field label="Notes" htmlFor="property-notes" error={errors.notes?.message}>
        <textarea id="property-notes" rows={2} className={inputClass} {...form.register("notes")} />
      </Field>

      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton
          label={editing ? "Enregistrer le bien" : "Ajouter le bien"}
          pending={isSubmitting}
        />
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <FormFeedback
          result={result}
          successMessage={editing ? "Bien mis à jour." : "Bien enregistré."}
        />
      </div>
    </form>
  );
}

