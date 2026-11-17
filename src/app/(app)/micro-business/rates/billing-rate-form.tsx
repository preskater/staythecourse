"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  billingRateInputSchema,
  type BillingRateInput,
} from "@/modules/micro-business/rates";
import { saveBillingRateAction } from "../rate-actions";

export type RateClientOption = {
  id: string;
  name: string;
};

/**
 * Saves one client billing-rate change point.
 *
 * The month is the point of change: the rate applies from that month until the next
 * entry. Saving the same client and month again corrects the change point rather than
 * duplicating it.
 */
export function BillingRateForm({
  clients,
  defaultMonth,
}: {
  clients: RateClientOption[];
  /** `YYYY-MM`. */
  defaultMonth: string;
}) {
  const form = useForm<BillingRateInput>({
    resolver: zodResolver(billingRateInputSchema, undefined, { raw: true }),
    defaultValues: {
      clientId: "",
      month: defaultMonth,
      hourlyRate: "",
      currency: "EUR",
    },
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    saveBillingRateAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field
        label="Client"
        htmlFor="billing-rate-client"
        error={errors.clientId?.message}
        hint="Seuls les clients non archivés sont proposés."
      >
        <select
          id="billing-rate-client"
          className={inputClass}
          {...form.register("clientId")}
        >
          <option value="">Choisir un client…</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="À partir du mois"
        htmlFor="billing-rate-month"
        error={errors.month?.message}
        hint="Le tarif s'applique à ce mois et aux suivants, jusqu'au prochain changement."
      >
        <input
          id="billing-rate-month"
          type="month"
          className={inputClass}
          {...form.register("month")}
        />
      </Field>

      <Field
        label="Taux horaire"
        htmlFor="billing-rate-amount"
        error={errors.hourlyRate?.message}
      >
        <input
          id="billing-rate-amount"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="85,00"
          {...form.register("hourlyRate")}
        />
      </Field>

      <Field label="Devise" htmlFor="billing-rate-currency" error={errors.currency?.message}>
        <select
          id="billing-rate-currency"
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
        <SubmitButton label="Enregistrer le tarif client" pending={isSubmitting} />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback result={result} successMessage="Tarif client enregistré." />
      </div>
    </form>
  );
}
