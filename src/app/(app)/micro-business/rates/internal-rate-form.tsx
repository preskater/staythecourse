"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  internalCostRateInputSchema,
  type InternalCostRateInput,
} from "@/modules/micro-business/rates";
import { saveInternalCostRateAction } from "../rate-actions";

/**
 * Saves one confidential internal-cost change point.
 *
 * Rendered only for a role holding `read-internal-rates`; the action checks the same
 * permission again on the server, so the hidden form is never the protection.
 */
export function InternalRateForm({
  defaultMonth,
}: {
  /** `YYYY-MM`. */
  defaultMonth: string;
}) {
  const form = useForm<InternalCostRateInput>({
    resolver: zodResolver(internalCostRateInputSchema, undefined, { raw: true }),
    defaultValues: {
      month: defaultMonth,
      hourlyRate: "",
      currency: "EUR",
    },
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    saveInternalCostRateAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field
        label="À partir du mois"
        htmlFor="internal-rate-month"
        error={errors.month?.message}
        hint="Le coût s'applique à ce mois et aux suivants, jusqu'au prochain changement."
      >
        <input
          id="internal-rate-month"
          type="month"
          className={inputClass}
          {...form.register("month")}
        />
      </Field>

      <Field
        label="Coût horaire chargé"
        htmlFor="internal-rate-amount"
        error={errors.hourlyRate?.message}
        hint="Coût interne (main-d'œuvre et charges), jamais un tarif facturé."
      >
        <input
          id="internal-rate-amount"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="48,00"
          {...form.register("hourlyRate")}
        />
      </Field>

      <Field label="Devise" htmlFor="internal-rate-currency" error={errors.currency?.message}>
        <select
          id="internal-rate-currency"
          className={inputClass}
          {...form.register("currency")}
        >
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <div className="sm:col-span-2">
        <SubmitButton label="Enregistrer le coût interne" pending={isSubmitting} />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback result={result} successMessage="Coût interne enregistré." />
      </div>
    </form>
  );
}
