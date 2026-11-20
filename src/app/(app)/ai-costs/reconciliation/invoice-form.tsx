"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  INVOICE_LINE_CATEGORIES,
  INVOICE_LINE_CATEGORY_LABELS,
  INVOICE_LINE_LIMIT,
  invoiceInputSchema,
  type InvoiceFormValues,
} from "@/modules/ai-costs/invoice";
import { AI_PROVIDERS } from "@/modules/integrations/ai-adapter";
import { createInvoiceAction } from "./actions";

export type InvoiceRateOption = { id: string; label: string };

const emptyLine = { label: "", amount: "", category: "USAGE" } as const;

/**
 * Types one provider invoice: header and lines, metadata only. The lines must add up
 * to the total; the reconciliation shows any gap instead of fixing it.
 */
export function InvoiceForm({ rates }: { rates: InvoiceRateOption[] }) {
  const form = useForm<InvoiceFormValues>({
    resolver: zodResolver(invoiceInputSchema, undefined, { raw: true }),
    defaultValues: {
      provider: "OPENAI",
      number: "",
      periodStart: "",
      periodEnd: "",
      issuedOn: "",
      currency: "USD",
      total: "",
      exchangeRateSnapshotId: "",
      notes: "",
      lines: [{ ...emptyLine }],
    },
  });
  const lines = useFieldArray({ control: form.control, name: "lines" });
  const { result, submit } = useRecordedAction(form, createInvoiceAction);
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field label="Fournisseur" htmlFor="invoice-provider" error={errors.provider?.message}>
        <select id="invoice-provider" className={inputClass} {...form.register("provider")}>
          {AI_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Numéro de facture" htmlFor="invoice-number" error={errors.number?.message}>
        <input id="invoice-number" className={inputClass} autoComplete="off" {...form.register("number")} />
      </Field>

      <Field label="Date d'émission" htmlFor="invoice-issued" error={errors.issuedOn?.message}>
        <input id="invoice-issued" type="date" className={inputClass} {...form.register("issuedOn")} />
      </Field>

      <Field label="Début de période" htmlFor="invoice-start" error={errors.periodStart?.message}>
        <input id="invoice-start" type="date" className={inputClass} {...form.register("periodStart")} />
      </Field>

      <Field label="Fin de période (incluse)" htmlFor="invoice-end" error={errors.periodEnd?.message}>
        <input id="invoice-end" type="date" className={inputClass} {...form.register("periodEnd")} />
      </Field>

      <Field label="Devise" htmlFor="invoice-currency" error={errors.currency?.message}>
        <select id="invoice-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Total facturé"
        htmlFor="invoice-total"
        error={errors.total?.message}
        hint="Tel qu'imprimé, taxes comprises. Négatif pour un avoir."
      >
        <input
          id="invoice-total"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          {...form.register("total")}
        />
      </Field>

      <Field
        label="Taux de change"
        htmlFor="invoice-rate"
        error={errors.exchangeRateSnapshotId?.message}
        hint="Requis si le fournisseur remonte ses coûts dans une autre devise, et pour toute ligne « Écart de change »."
      >
        <select id="invoice-rate" className={inputClass} {...form.register("exchangeRateSnapshotId")}>
          <option value="">Aucun</option>
          {rates.map((rate) => (
            <option key={rate.id} value={rate.id}>
              {rate.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Notes" htmlFor="invoice-notes" error={errors.notes?.message}>
        <textarea id="invoice-notes" rows={1} className={inputClass} {...form.register("notes")} />
      </Field>

      <fieldset className="sm:col-span-2 lg:col-span-3 flex flex-col gap-2">
        <legend className="text-sm font-medium">Lignes de la facture</legend>
        {lines.fields.map((field, index) => {
          const lineErrors = errors.lines?.[index];
          return (
            <div key={field.id} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-start">
              <Field label={`Libellé ${index + 1}`} htmlFor={`line-${index}-label`} error={lineErrors?.label?.message}>
                <input
                  id={`line-${index}-label`}
                  className={inputClass}
                  autoComplete="off"
                  {...form.register(`lines.${index}.label`)}
                />
              </Field>
              <Field label="Catégorie" htmlFor={`line-${index}-category`} error={lineErrors?.category?.message}>
                <select id={`line-${index}-category`} className={inputClass} {...form.register(`lines.${index}.category`)}>
                  {INVOICE_LINE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {INVOICE_LINE_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Montant" htmlFor={`line-${index}-amount`} error={lineErrors?.amount?.message}>
                <input
                  id={`line-${index}-amount`}
                  className={inputClass}
                  inputMode="decimal"
                  autoComplete="off"
                  {...form.register(`lines.${index}.amount`)}
                />
              </Field>
              <button
                type="button"
                onClick={() => lines.remove(index)}
                disabled={lines.fields.length === 1}
                aria-label={`Retirer la ligne ${index + 1}`}
                className="self-end rounded-md border border-zinc-300 px-2 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Retirer
              </button>
            </div>
          );
        })}
        {errors.lines?.message || errors.lines?.root?.message ? (
          <p className="text-xs text-rose-700 dark:text-rose-400" role="alert">
            {errors.lines?.message ?? errors.lines?.root?.message}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => lines.append({ ...emptyLine })}
          disabled={lines.fields.length >= INVOICE_LINE_LIMIT}
          className="self-start rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Ajouter une ligne
        </button>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Seules les lignes « Usage » sont comparées au coût remonté par le fournisseur. Crédits, remises, taxes et
          écarts de change expliquent le reste ; une ligne « Autre » reste non rapprochée.
        </p>
      </fieldset>

      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton label="Enregistrer la facture" pending={isSubmitting} />
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <FormFeedback result={result} successMessage="Facture enregistrée." />
      </div>
    </form>
  );
}
