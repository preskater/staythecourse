"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import {
  REVENUE_DOCUMENT_KINDS,
  REVENUE_DOCUMENT_KIND_LABELS,
  revenueDocumentInputSchema,
  type RevenueDocumentInput,
} from "@/modules/micro-business/revenue";
import { createRevenueDocumentAction } from "../revenue-actions";

/** A billable project offered to the invoice form; strings only, no `Date`/`Decimal`. */
export type RevenueProjectOption = {
  id: string;
  name: string;
  clientName: string;
  currency: string;
};

/** An invoice offered to the credit-note form, with its current balance. */
export type RevenueInvoiceOption = {
  id: string;
  label: string;
};

/**
 * Creates an invoice or a credit note.
 *
 * The two kinds share one form so switching never loses what was typed. An invoice
 * needs a billable project and a due date; a credit note names the invoice it reduces
 * and carries no due date or recognition of its own. The currency is never asked: the
 * server takes the project's, and nothing is converted.
 */
export function RevenueDocumentForm({
  projects,
  invoices,
  today,
}: {
  projects: RevenueProjectOption[];
  invoices: RevenueInvoiceOption[];
  /** `YYYY-MM-DD`, the owner's calendar day. */
  today: string;
}) {
  const defaults: RevenueDocumentInput = {
    kind: "INVOICE",
    projectId: "",
    creditNoteForId: "",
    amount: "",
    issuedOn: today,
    dueOn: "",
    recognizedOn: "",
    recognizedAmount: "",
    notes: "",
  };

  const form = useForm<RevenueDocumentInput>({
    resolver: zodResolver(revenueDocumentInputSchema, undefined, { raw: true }),
    defaultValues: defaults,
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    createRevenueDocumentAction(values),
  );
  const { errors, isSubmitting } = form.formState;
  const kind = useWatch({ control: form.control, name: "kind" });
  const isInvoice = kind === "INVOICE";

  // A credit note has no due date, recognition or project of its own; leaving those
  // values behind would fail validation on fields that are no longer on screen.
  useEffect(() => {
    if (kind === "CREDIT_NOTE") {
      form.setValue("dueOn", "");
      form.setValue("recognizedOn", "");
      form.setValue("recognizedAmount", "");
      form.setValue("projectId", "");
    } else {
      form.setValue("creditNoteForId", "");
    }
    form.clearErrors();
  }, [kind, form]);

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label="Type de document" htmlFor="revenue-kind" error={errors.kind?.message}>
        <select id="revenue-kind" className={inputClass} {...form.register("kind")}>
          {REVENUE_DOCUMENT_KINDS.map((value) => (
            <option key={value} value={value}>
              {REVENUE_DOCUMENT_KIND_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>

      {isInvoice ? (
        <Field
          label="Projet"
          htmlFor="revenue-project"
          error={errors.projectId?.message}
          hint="Seuls les projets facturables non archivés sont proposés."
        >
          <select id="revenue-project" className={inputClass} {...form.register("projectId")}>
            <option value="">Choisir un projet…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} — {project.clientName} ({project.currency})
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field
          label="Facture réduite"
          htmlFor="revenue-credit-note-for"
          error={errors.creditNoteForId?.message}
          hint="L'avoir reprend le projet, le client et la devise de cette facture."
        >
          <select
            id="revenue-credit-note-for"
            className={inputClass}
            {...form.register("creditNoteForId")}
          >
            <option value="">Choisir une facture…</option>
            {invoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Montant" htmlFor="revenue-amount" error={errors.amount?.message}>
        <input
          id="revenue-amount"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="1 250,00"
          {...form.register("amount")}
        />
      </Field>

      <Field
        label={isInvoice ? "Date de facturation" : "Date de l'avoir"}
        htmlFor="revenue-issued-on"
        error={errors.issuedOn?.message}
      >
        <input
          id="revenue-issued-on"
          type="date"
          className={inputClass}
          {...form.register("issuedOn")}
        />
      </Field>

      {isInvoice ? (
        <>
          <Field
            label="Échéance"
            htmlFor="revenue-due-on"
            error={errors.dueOn?.message}
            hint="Le jour de l'échéance n'est pas encore en retard ; le lendemain l'est."
          >
            <input
              id="revenue-due-on"
              type="date"
              className={inputClass}
              {...form.register("dueOn")}
            />
          </Field>

          <Field
            label="Date de reconnaissance"
            htmlFor="revenue-recognized-on"
            error={errors.recognizedOn?.message}
            hint="Facultatif : à renseigner avec le montant reconnu."
          >
            <input
              id="revenue-recognized-on"
              type="date"
              className={inputClass}
              {...form.register("recognizedOn")}
            />
          </Field>

          <Field
            label="Montant reconnu"
            htmlFor="revenue-recognized-amount"
            error={errors.recognizedAmount?.message}
            hint="Le chiffre reconnu reste figé : les avoirs et encaissements ultérieurs ne le réécrivent pas."
          >
            <input
              id="revenue-recognized-amount"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="1 250,00"
              {...form.register("recognizedAmount")}
            />
          </Field>
        </>
      ) : null}

      <div className="sm:col-span-2">
        <Field label="Notes" htmlFor="revenue-notes" error={errors.notes?.message}>
          <input
            id="revenue-notes"
            className={inputClass}
            autoComplete="off"
            {...form.register("notes")}
          />
        </Field>
      </div>

      <div className="sm:col-span-2">
        <SubmitButton
          label={isInvoice ? "Enregistrer la facture" : "Enregistrer l'avoir"}
          pending={isSubmitting}
        />
      </div>

      <div className="sm:col-span-2">
        <FormFeedback
          result={result}
          successMessage={isInvoice ? "Facture enregistrée." : "Avoir enregistré."}
        />
      </div>
    </form>
  );
}
