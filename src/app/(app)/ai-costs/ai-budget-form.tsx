"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  AI_BUDGET_DIMENSIONS,
  aiBudgetInputSchema,
  type AiBudgetFormValues,
} from "@/modules/ai-costs/budgets";
import { saveAiBudgetAction } from "./budget-actions";

/**
 * Creates an AI budget, or replaces the cap of the same scope and currency.
 *
 * The value is the ledger's own identifier (provider name, project identifier...), as
 * the explorer lists it: a budget watches exactly what the entries carry.
 */
export function AiBudgetForm({ defaultCurrency }: { defaultCurrency: string }) {
  const form = useForm<AiBudgetFormValues>({
    resolver: zodResolver(aiBudgetInputSchema, undefined, { raw: true }),
    defaultValues: { dimension: "workspace", dimensionValue: "", amount: "", currency: defaultCurrency },
  });

  const { result, submit } = useRecordedAction(form, (values) => saveAiBudgetAction(values));
  const { errors, isSubmitting } = form.formState;
  const isWorkspace = useWatch({ control: form.control, name: "dimension" }) === "workspace";

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <Field label="Périmètre" htmlFor="ai-budget-dimension" error={errors.dimension?.message}>
        <select id="ai-budget-dimension" className={inputClass} {...form.register("dimension")}>
          {AI_BUDGET_DIMENSIONS.map(({ code, label }) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Valeur"
        htmlFor="ai-budget-value"
        error={errors.dimensionValue?.message}
        hint={isWorkspace ? "Sans objet pour tout l'espace." : "Identifiant tel qu'il figure dans l'explorateur."}
      >
        <input
          id="ai-budget-value"
          className={inputClass}
          autoComplete="off"
          readOnly={isWorkspace}
          placeholder={isWorkspace ? "" : "openai"}
          {...form.register("dimensionValue")}
        />
      </Field>

      <Field label="Budget mensuel" htmlFor="ai-budget-amount" error={errors.amount?.message}>
        <input
          id="ai-budget-amount"
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          placeholder="200,00"
          {...form.register("amount")}
        />
      </Field>

      <Field
        label="Devise"
        htmlFor="ai-budget-currency"
        error={errors.currency?.message}
        hint="Seules les dépenses dans cette devise sont comparées."
      >
        <select id="ai-budget-currency" className={inputClass} {...form.register("currency")}>
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-4">
        <SubmitButton label="Enregistrer le budget" pending={isSubmitting} />
        <FormFeedback result={result} successMessage="Budget IA enregistré." />
      </div>
    </form>
  );
}
