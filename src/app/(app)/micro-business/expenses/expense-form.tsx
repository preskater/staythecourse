"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  RECURRENCE_FREQUENCIES,
  RECURRENCE_FREQUENCY_LABELS,
} from "@/modules/budget/recurrence";
import {
  BUSINESS_EXPENSE_KINDS,
  BUSINESS_EXPENSE_KIND_LABELS,
  businessExpenseInputSchema,
  type BusinessExpenseInput,
} from "@/modules/micro-business/expenses";
import { createBusinessExpenseAction } from "../expense-actions";

/**
 * Creates one recurring business expense or obligation.
 *
 * The series is a planning definition: it never writes to the budget. The first date
 * sets both the start and the renewal day of the month; the cadence counts from its
 * month, and the optional end date is inclusive.
 */
export function BusinessExpenseForm({
  today,
}: {
  /** `YYYY-MM-DD`, the owner's calendar day. */
  today: string;
}) {
  const form = useForm<BusinessExpenseInput>({
    resolver: zodResolver(businessExpenseInputSchema, undefined, { raw: true }),
    defaultValues: {
      label: "",
      vendor: "",
      kind: "EXPENSE",
      amount: "",
      currency: "EUR",
      frequency: "MONTHLY",
      startDate: today,
      endDate: "",
      notes: "",
    },
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    createBusinessExpenseAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label="Libellé" htmlFor="expense-label" error={errors.label?.message}>
        <input
          id="expense-label"
          className={inputClass}
          autoComplete="off"
          placeholder="Assurance responsabilité civile"
          {...form.register("label")}
        />
      </Field>

      <Field
        label="Fournisseur"
        htmlFor="expense-vendor"
        error={errors.vendor?.message}
        hint="Facultatif."
      >
        <input
          id="expense-vendor"
          className={inputClass}
          autoComplete="off"
          {...form.register("vendor")}
        />
      </Field>

      <Field label="Type" htmlFor="expense-kind" error={errors.kind?.message}>
        <select id="expense-kind" className={inputClass} {...form.register("kind")}>
          {BUSINESS_EXPENSE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {BUSINESS_EXPENSE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Montant prévu"
        htmlFor="expense-amount"
        error={errors.amount?.message}
        hint="Une estimation de planification, jamais un paiement."
      >
        <input
          id="expense-amount"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="120,00"
          {...form.register("amount")}
        />
      </Field>

      <Field label="Devise" htmlFor="expense-currency" error={errors.currency?.message}>
        <select id="expense-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Cadence"
        htmlFor="expense-frequency"
        error={errors.frequency?.message}
        hint="Comptée depuis le mois de début."
      >
        <select
          id="expense-frequency"
          className={inputClass}
          {...form.register("frequency")}
        >
          {RECURRENCE_FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {RECURRENCE_FREQUENCY_LABELS[frequency]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Première échéance"
        htmlFor="expense-start"
        error={errors.startDate?.message}
        hint="Son jour du mois devient le jour de renouvellement (ramené au dernier jour des mois plus courts)."
      >
        <input
          id="expense-start"
          type="date"
          className={inputClass}
          {...form.register("startDate")}
        />
      </Field>

      <Field
        label="Dernière échéance"
        htmlFor="expense-end"
        error={errors.endDate?.message}
        hint="Facultatif : vide signifie une série sans fin."
      >
        <input
          id="expense-end"
          type="date"
          className={inputClass}
          {...form.register("endDate")}
        />
      </Field>

      <div className="sm:col-span-2">
        <Field label="Notes" htmlFor="expense-notes" error={errors.notes?.message}>
          <input
            id="expense-notes"
            className={inputClass}
            autoComplete="off"
            {...form.register("notes")}
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <SubmitButton label="Enregistrer la charge" pending={isSubmitting} />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback result={result} successMessage="Charge récurrente enregistrée." />
      </div>
    </form>
  );
}
