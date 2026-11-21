"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { RECURRENCE_FREQUENCIES, RECURRENCE_FREQUENCY_LABELS } from "@/modules/budget/recurrence";
import {
  aiSubscriptionInputSchema,
  type AiSubscriptionFormValues,
} from "@/modules/ai-costs/subscriptions";
import { createAiSubscriptionAction } from "./subscription-actions";

/**
 * Declares one AI subscription. Renewals already due are booked in the ledger on save;
 * later ones as their date comes.
 */
export function SubscriptionForm({
  today,
  defaultCurrency,
  policies,
}: {
  /** `YYYY-MM-DD`, the owner's calendar day. */
  today: string;
  defaultCurrency: string;
  /** Active policies a renewal can apply (seat, percentage or revenue). */
  policies: { id: string; name: string }[];
}) {
  const form = useForm<AiSubscriptionFormValues>({
    resolver: zodResolver(aiSubscriptionInputSchema, undefined, { raw: true }),
    defaultValues: {
      provider: "",
      plan: "",
      seats: "1",
      seatPrice: "",
      currency: defaultCurrency,
      frequency: "MONTHLY",
      startDate: today,
      allowance: "",
      ownerId: "",
      allocationPolicyId: "",
      notes: "",
    },
  });

  const { result, submit } = useRecordedAction(form, (values) => createAiSubscriptionAction(values));
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <Field label="Fournisseur" htmlFor="sub-provider" error={errors.provider?.message} hint="Tel que dans le registre, ex. openai.">
        <input id="sub-provider" className={inputClass} autoComplete="off" {...form.register("provider")} />
      </Field>
      <Field label="Offre" htmlFor="sub-plan" error={errors.plan?.message}>
        <input id="sub-plan" className={inputClass} autoComplete="off" placeholder="Team" {...form.register("plan")} />
      </Field>
      <Field label="Sièges" htmlFor="sub-seats" error={errors.seats?.message}>
        <input id="sub-seats" className={inputClass} inputMode="numeric" autoComplete="off" {...form.register("seats")} />
      </Field>
      <Field label="Prix par siège" htmlFor="sub-price" error={errors.seatPrice?.message}>
        <input id="sub-price" className={inputClass} inputMode="decimal" autoComplete="off" placeholder="25,00" {...form.register("seatPrice")} />
      </Field>
      <Field label="Devise" htmlFor="sub-currency" error={errors.currency?.message}>
        <select id="sub-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Cadence" htmlFor="sub-frequency" error={errors.frequency?.message}>
        <select id="sub-frequency" className={inputClass} {...form.register("frequency")}>
          {RECURRENCE_FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {RECURRENCE_FREQUENCY_LABELS[frequency]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Premier renouvellement" htmlFor="sub-start" error={errors.startDate?.message}>
        <input id="sub-start" type="date" className={inputClass} {...form.register("startDate")} />
      </Field>
      <Field label="Enveloppe incluse" htmlFor="sub-allowance" error={errors.allowance?.message} hint="Crédit d'usage par période, optionnel.">
        <input id="sub-allowance" className={inputClass} inputMode="decimal" autoComplete="off" {...form.register("allowance")} />
      </Field>
      <Field label="Responsable" htmlFor="sub-owner" error={errors.ownerId?.message} hint="Identifiant développeur, optionnel.">
        <input id="sub-owner" className={inputClass} autoComplete="off" {...form.register("ownerId")} />
      </Field>
      <Field label="Répartition" htmlFor="sub-policy" error={errors.allocationPolicyId?.message}>
        <select id="sub-policy" className={inputClass} {...form.register("allocationPolicyId")}>
          <option value="">Aucune</option>
          {policies.map((policy) => (
            <option key={policy.id} value={policy.id}>
              {policy.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes" htmlFor="sub-notes" error={errors.notes?.message}>
        <input id="sub-notes" className={inputClass} autoComplete="off" {...form.register("notes")} />
      </Field>

      <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-4">
        <SubmitButton label="Enregistrer l'abonnement" pending={isSubmitting} />
        <FormFeedback result={result} successMessage="Abonnement enregistré." />
      </div>
    </form>
  );
}
