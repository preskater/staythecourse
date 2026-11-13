"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import {
  REVENUE_MOVEMENT_TYPES,
  REVENUE_MOVEMENT_TYPE_LABELS,
  revenueMovementInputSchema,
  type RevenueMovementInput,
} from "@/modules/micro-business/revenue";
import { recordRevenueMovementAction } from "../revenue-actions";
import type { RevenueInvoiceOption } from "./revenue-form";

/**
 * Records one settlement row on an invoice.
 *
 * The three movements share the form: the document's current balance is shown in the
 * option label, and the server refuses an amount that would overpay, over-refund or
 * write off more than the remaining balance. Dates are calendar days.
 */
export function RevenueMovementForm({
  invoices,
  today,
}: {
  invoices: RevenueInvoiceOption[];
  /** `YYYY-MM-DD`, the owner's calendar day. */
  today: string;
}) {
  const defaults: RevenueMovementInput = {
    type: "PAYMENT",
    documentId: "",
    amount: "",
    date: today,
    notes: "",
  };

  const form = useForm<RevenueMovementInput>({
    resolver: zodResolver(revenueMovementInputSchema, undefined, { raw: true }),
    defaultValues: defaults,
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    recordRevenueMovementAction(values),
  );
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label="Mouvement" htmlFor="revenue-movement-type" error={errors.type?.message}>
        <select
          id="revenue-movement-type"
          className={inputClass}
          {...form.register("type")}
        >
          {REVENUE_MOVEMENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {REVENUE_MOVEMENT_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Facture"
        htmlFor="revenue-movement-document"
        error={errors.documentId?.message}
        hint="Le reste dû et le montant net encaissé sont rappelés dans le choix."
      >
        <select
          id="revenue-movement-document"
          className={inputClass}
          {...form.register("documentId")}
        >
          <option value="">Choisir une facture…</option>
          {invoices.map((invoice) => (
            <option key={invoice.id} value={invoice.id}>
              {invoice.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Montant" htmlFor="revenue-movement-amount" error={errors.amount?.message}>
        <input
          id="revenue-movement-amount"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="400,00"
          {...form.register("amount")}
        />
      </Field>

      <Field label="Date" htmlFor="revenue-movement-date" error={errors.date?.message}>
        <input
          id="revenue-movement-date"
          type="date"
          className={inputClass}
          {...form.register("date")}
        />
      </Field>

      <div className="sm:col-span-2">
        <Field label="Notes" htmlFor="revenue-movement-notes" error={errors.notes?.message}>
          <input
            id="revenue-movement-notes"
            className={inputClass}
            autoComplete="off"
            {...form.register("notes")}
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <SubmitButton label="Enregistrer le mouvement" pending={isSubmitting} />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback result={result} successMessage="Mouvement enregistré." />
      </div>
    </form>
  );
}
