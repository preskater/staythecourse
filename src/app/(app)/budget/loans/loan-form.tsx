"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, Notice, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  LOAN_INSURANCE_MODES,
  LOAN_INSURANCE_MODE_LABELS,
  LOAN_PURPOSES,
  LOAN_PURPOSE_LABELS,
  loanInputSchema,
  type LoanFormValues,
  type LoanInput,
} from "@/modules/loans/domain";
import { createLoanAction, updateLoanAction } from "./actions";

/**
 * Creates or edits a loan.
 *
 * A missing rate, term, insurance or balance is a deliberate empty field: the payload
 * carries `""`, the shared schema turns it into `null`, and the row reads "non
 * renseigné". Nothing is ever saved as a zero the owner did not type.
 */
export function LoanForm({
  properties,
  loan,
  propertyLinkLocked = false,
  propertyName = null,
  defaultCurrency = "EUR",
}: {
  properties: { id: string; name: string }[];
  loan?: LoanFormValues | null;
  /** True when the loan already has a property but the real-estate module is inactive. */
  propertyLinkLocked?: boolean;
  propertyName?: string | null;
  defaultCurrency?: string;
}) {
  const editing = Boolean(loan?.id);

  const form = useForm<LoanInput>({
    resolver: zodResolver(loanInputSchema, undefined, { raw: true }),
    defaultValues: formDefaults(loan, defaultCurrency),
  });

  const { result, submit } = useRecordedAction(form, (values) =>
    loan?.id ? updateLoanAction({ ...values, id: loan.id }) : createLoanAction(values),
  );
  const { errors, isSubmitting } = form.formState;
  const insuranceMode = useWatch({ control: form.control, name: "insuranceMode" });

  // `defaultValues` are read once: a refreshed loan or a switch to another row must
  // reset the fields, exactly like the other edit forms.
  useEffect(() => {
    form.reset(formDefaults(loan, defaultCurrency));
  }, [loan, defaultCurrency, form]);

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field
        label="Libellé"
        htmlFor="loan-label"
        error={errors.label?.message}
        hint="Par exemple : prêt auto 2026, crédit travaux."
      >
        <input
          id="loan-label"
          className={inputClass}
          autoComplete="off"
          {...form.register("label")}
        />
      </Field>

      <Field label="Prêteur" htmlFor="loan-lender" error={errors.lender?.message} hint="Facultatif.">
        <input
          id="loan-lender"
          className={inputClass}
          autoComplete="off"
          placeholder="Banque, organisme, proche…"
          {...form.register("lender")}
        />
      </Field>

      <Field label="Objet du prêt" htmlFor="loan-purpose" error={errors.purpose?.message}>
        <select id="loan-purpose" className={inputClass} {...form.register("purpose")}>
          {LOAN_PURPOSES.map((purpose) => (
            <option key={purpose} value={purpose}>
              {LOAN_PURPOSE_LABELS[purpose]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Devise" htmlFor="loan-currency" error={errors.currency?.message}>
        <select id="loan-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Capital emprunté"
        htmlFor="loan-principal"
        error={errors.initialPrincipal?.message}
        hint="Montant positif, exact au centime."
      >
        <input
          id="loan-principal"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="250000,00"
          {...form.register("initialPrincipal")}
        />
      </Field>

      <Field
        label="Taux annuel (%)"
        htmlFor="loan-rate"
        error={errors.annualRate?.message}
        hint="Facultatif : vide signifie « non renseigné », jamais 0. Formats acceptés : 3,45 ou 3,45 %."
      >
        <input
          id="loan-rate"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="Non renseigné"
          {...form.register("annualRate")}
        />
      </Field>

      <Field
        label="Durée (mois)"
        htmlFor="loan-term"
        error={errors.termMonths?.message}
        hint="Facultatif : un nombre entier de mois, ou « non renseigné » si le terme est inconnu."
      >
        <input
          id="loan-term"
          className={inputClass}
          inputMode="numeric"
          autoComplete="off"
          placeholder="Non renseigné"
          {...form.register("termMonths")}
        />
      </Field>

      <Field label="Date de début" htmlFor="loan-start" error={errors.startDate?.message} hint="Facultatif.">
        <input id="loan-start" type="date" className={inputClass} {...form.register("startDate")} />
      </Field>

      <Field
        label="Première échéance"
        htmlFor="loan-first-due"
        error={errors.firstDueDate?.message}
        hint="Facultatif. Son jour devient le jour de paiement si celui-ci reste vide."
      >
        <input
          id="loan-first-due"
          type="date"
          className={inputClass}
          {...form.register("firstDueDate")}
        />
      </Field>

      <Field
        label="Jour de paiement"
        htmlFor="loan-payment-day"
        error={errors.paymentDay?.message}
        hint="Entre 1 et 31, ramené au dernier jour des mois plus courts. Vide = déduit de la première échéance."
      >
        <input
          id="loan-payment-day"
          className={inputClass}
          inputMode="numeric"
          autoComplete="off"
          placeholder="Non renseigné"
          {...form.register("paymentDay")}
        />
      </Field>

      <Field
        label="Différé (mois)"
        htmlFor="loan-deferral"
        error={errors.interestOnlyMonths?.message}
        hint="Nombre de mois où seuls les intérêts sont payés. 0 par défaut."
      >
        <input
          id="loan-deferral"
          className={inputClass}
          inputMode="numeric"
          autoComplete="off"
          {...form.register("interestOnlyMonths")}
        />
      </Field>

      <Field label="Assurance" htmlFor="loan-insurance-mode" error={errors.insuranceMode?.message}>
        <select
          id="loan-insurance-mode"
          className={inputClass}
          {...form.register("insuranceMode")}
        >
          <option value="">Non renseigné</option>
          {LOAN_INSURANCE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {LOAN_INSURANCE_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </Field>

      {insuranceMode === "FIXED_MONTHLY" ? (
        <Field
          label="Assurance mensuelle"
          htmlFor="loan-insurance-amount"
          error={errors.insuranceMonthlyAmount?.message}
          hint="Montant fixe enregistré tel quel."
        >
          <input
            id="loan-insurance-amount"
            className={inputClass}
            inputMode="decimal"
            autoComplete="off"
            placeholder="45,00"
            {...form.register("insuranceMonthlyAmount")}
          />
        </Field>
      ) : null}

      {insuranceMode === "RATE_OF_PRINCIPAL" || insuranceMode === "RATE_OF_BALANCE" ? (
        <Field
          label="Taux d'assurance (%)"
          htmlFor="loan-insurance-rate"
          error={errors.insuranceRate?.message}
          hint={
            insuranceMode === "RATE_OF_BALANCE"
              ? "Taux annuel, appliqué au solde restant dû : sans solde enregistré, le coût mensuel reste « non renseigné »."
              : "Taux annuel, appliqué au capital emprunté."
          }
        >
          <input
            id="loan-insurance-rate"
            className={inputClass}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,35"
            {...form.register("insuranceRate")}
          />
        </Field>
      ) : null}

      {insuranceMode === "NONE" ? (
        <div className="sm:col-span-2 lg:col-span-3">
          <Notice tone="info">
            Aucune assurance ne sera enregistrée : ce choix est explicite, il ne vaut pas
            « non renseigné ».
          </Notice>
        </div>
      ) : null}

      {insuranceMode === "" || insuranceMode === null || insuranceMode === undefined ? (
        <div className="sm:col-span-2 lg:col-span-3">
          <Notice tone="info">
            Assurance non renseignée : elle sera enregistrée « non renseignée », jamais à
            zéro. Choisissez « Aucune assurance » pour affirmer qu&apos;il n&apos;y en a pas.
          </Notice>
        </div>
      ) : null}

      <Field
        label="Frais de dossier"
        htmlFor="loan-fees"
        error={errors.fees?.message}
        hint="Facultatif : vide signifie « non renseigné »."
      >
        <input
          id="loan-fees"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="Non renseigné"
          {...form.register("fees")}
        />
      </Field>

      {propertyLinkLocked ? (
        <div className="sm:col-span-2 lg:col-span-3">
          <input type="hidden" {...form.register("propertyId")} />
          <Notice tone="warning">
            Bien lié : {propertyName ?? "bien inconnu"}. Le module Immobilier est inactif
            dans cet espace : le lien existant est conservé, mais ne peut pas être modifié
            tant que le module reste désactivé.
          </Notice>
        </div>
      ) : (
        <Field
          label="Bien associé"
          htmlFor="loan-property"
          error={errors.propertyId?.message}
          hint={
            properties.length === 0
              ? "Aucun bien enregistré : le prêt reste indépendant d'un bien."
              : "Facultatif. Nécessite le module Immobilier."
          }
        >
          <select
            id="loan-property"
            className={inputClass}
            disabled={properties.length === 0}
            {...form.register("propertyId")}
          >
            <option value="">Aucun bien</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="Solde restant dû"
        htmlFor="loan-outstanding"
        error={errors.outstandingBalance?.message}
        hint="Facultatif : un relevé manuel, jamais une valeur calculée. Vide = « non renseigné »."
      >
        <input
          id="loan-outstanding"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="Non renseigné"
          {...form.register("outstandingBalance")}
        />
      </Field>

      <Field
        label="Solde observé le"
        htmlFor="loan-balance-as-of"
        error={errors.balanceAsOf?.message}
        hint="À renseigner avec le solde : vide si le solde n'est pas connu."
      >
        <input
          id="loan-balance-as-of"
          type="date"
          className={inputClass}
          {...form.register("balanceAsOf")}
        />
      </Field>

      <Field label="Notes" htmlFor="loan-notes" error={errors.notes?.message} hint="Facultatif.">
        <textarea id="loan-notes" rows={2} className={inputClass} {...form.register("notes")} />
      </Field>

      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton
          label={editing ? "Enregistrer le prêt" : "Ajouter le prêt"}
          pending={isSubmitting}
        />
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <FormFeedback
          result={result}
          successMessage={editing ? "Prêt mis à jour." : "Prêt enregistré."}
        />
      </div>
    </form>
  );
}

const EMPTY = {
  label: "",
  lender: "",
  notes: "",
  purpose: "OTHER",
  currency: "EUR",
  initialPrincipal: "",
  annualRate: "",
  termMonths: "",
  startDate: "",
  firstDueDate: "",
  paymentDay: "",
  interestOnlyMonths: "0",
  insuranceMode: "",
  insuranceMonthlyAmount: "",
  insuranceRate: "",
  fees: "",
  propertyId: "",
  outstandingBalance: "",
  balanceAsOf: "",
} as const;

function formDefaults(
  loan: LoanFormValues | null | undefined,
  defaultCurrency: string,
): LoanInput {
  if (!loan) {
    return { ...EMPTY, currency: defaultCurrency };
  }

  return {
    label: loan.label,
    lender: loan.lender,
    notes: loan.notes,
    purpose: loan.purpose,
    currency: loan.currency,
    initialPrincipal: loan.initialPrincipal,
    annualRate: loan.annualRate,
    termMonths: loan.termMonths,
    startDate: loan.startDate,
    firstDueDate: loan.firstDueDate,
    paymentDay: loan.paymentDay,
    interestOnlyMonths: loan.interestOnlyMonths,
    insuranceMode: loan.insuranceMode,
    insuranceMonthlyAmount: loan.insuranceMonthlyAmount,
    insuranceRate: loan.insuranceRate,
    fees: loan.fees,
    propertyId: loan.propertyId,
    outstandingBalance: loan.outstandingBalance,
    balanceAsOf: loan.balanceAsOf,
  };
}
