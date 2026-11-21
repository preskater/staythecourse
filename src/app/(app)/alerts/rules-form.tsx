"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormFeedback, SubmitButton, useRecordedAction } from "@/components/forms";
import { Field, inputClass } from "@/components/ui";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import {
  ALERT_KIND_LABELS,
  ALERT_RULE_DESCRIPTIONS,
  alertRulesInputSchema,
  type AlertRulesFormValues,
} from "@/modules/alerts/domain";
import { saveAlertRulesAction } from "./actions";

/**
 * The rules, each with its thresholds and what it watches.
 *
 * The explanations are part of the form, not a tooltip: a threshold whose meaning has to
 * be guessed is a threshold nobody dares to set. An empty field means "use the default",
 * and the default is spelled out in the placeholder.
 */
export function RulesForm({ defaults }: { defaults: AlertRulesFormValues }) {
  const form = useForm<AlertRulesFormValues>({
    resolver: zodResolver(alertRulesInputSchema, undefined, { raw: true }),
    defaultValues: defaults,
  });

  // Wrapped rather than passed directly: the action takes `unknown` (it re-validates
  // everything), and the form's own type must drive the submit contract.
  const { result, submit } = useRecordedAction(form, (values) => saveAlertRulesAction(values));
  const { errors, isSubmitting } = form.formState;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.LOW_BALANCE}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.LOW_BALANCE}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("lowBalance.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Seuil"
            htmlFor="alert-low-balance-amount"
            error={errors.lowBalance?.thresholdAmount?.message}
            hint="Vide : 0,00 (comptes à découvert uniquement)."
          >
            <input
              id="alert-low-balance-amount"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              {...form.register("lowBalance.thresholdAmount")}
            />
          </Field>

          <Field
            label="Devise du seuil"
            htmlFor="alert-low-balance-currency"
            error={errors.lowBalance?.thresholdCurrency?.message}
            hint="Un seuil de zéro vaut pour toutes les devises."
          >
            <select
              id="alert-low-balance-currency"
              className={inputClass}
              {...form.register("lowBalance.thresholdCurrency")}
            >
              <option value="">Toutes (seuil 0)</option>
              {SUPPORTED_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.BUDGET_OVERRUN}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.BUDGET_OVERRUN}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("budgetOverrun.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Marge de dépassement (%)"
            htmlFor="alert-overrun-percent"
            error={errors.budgetOverrun?.thresholdPercent?.message}
            hint="Vide : 0 (tout dépassement)."
          >
            <input
              id="alert-overrun-percent"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              {...form.register("budgetOverrun.thresholdPercent")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.BUDGET_THRESHOLD}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.BUDGET_THRESHOLD}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("budgetThreshold.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Seuil d'alerte (% du budget)"
            htmlFor="alert-threshold-percent"
            error={errors.budgetThreshold?.thresholdPercent?.message}
            hint="Vide : 80 — l'alerte se résout d'elle-même si le dépassement prend le relais."
          >
            <input
              id="alert-threshold-percent"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="80"
              {...form.register("budgetThreshold.thresholdPercent")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.UNUSUAL_EXPENSE}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.UNUSUAL_EXPENSE}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("unusualExpense.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Seuil"
            htmlFor="alert-unusual-amount"
            error={errors.unusualExpense?.thresholdAmount?.message}
            hint="Vide : 500,00."
          >
            <input
              id="alert-unusual-amount"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="500,00"
              {...form.register("unusualExpense.thresholdAmount")}
            />
          </Field>

          <Field
            label="Devise du seuil"
            htmlFor="alert-unusual-currency"
            error={errors.unusualExpense?.thresholdCurrency?.message}
            hint="Les dépenses dans une autre devise sont ignorées."
          >
            <select
              id="alert-unusual-currency"
              className={inputClass}
              {...form.register("unusualExpense.thresholdCurrency")}
            >
              <option value="">Choisir…</option>
              {SUPPORTED_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.STALE_INTEGRATION}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.STALE_INTEGRATION}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("staleIntegration.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Ancienneté (jours)"
            htmlFor="alert-stale-days"
            error={errors.staleIntegration?.thresholdDays?.message}
            hint="Vide : 1 jour. Minimum : 1."
          >
            <input
              id="alert-stale-days"
              className={inputClass}
              inputMode="numeric"
              autoComplete="off"
              placeholder="1"
              {...form.register("staleIntegration.thresholdDays")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.OVERDUE_EVENT}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.OVERDUE_EVENT}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("overdueEvent.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Grâce (jours)"
            htmlFor="alert-overdue-days"
            error={errors.overdueEvent?.thresholdDays?.message}
            hint="Vide : 0 (dès le lendemain de l'échéance)."
          >
            <input
              id="alert-overdue-days"
              className={inputClass}
              inputMode="numeric"
              autoComplete="off"
              placeholder="0"
              {...form.register("overdueEvent.thresholdDays")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.AI_BUDGET_OVERRUN}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.AI_BUDGET_OVERRUN}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("aiBudgetOverrun.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Marge de dépassement (%)"
            htmlFor="alert-ai-overrun-percent"
            error={errors.aiBudgetOverrun?.thresholdPercent?.message}
            hint="Vide : 0 (tout dépassement)."
          >
            <input
              id="alert-ai-overrun-percent"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              {...form.register("aiBudgetOverrun.thresholdPercent")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium">{ALERT_KIND_LABELS.AI_BUDGET_THRESHOLD}</legend>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {ALERT_RULE_DESCRIPTIONS.AI_BUDGET_THRESHOLD}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("aiBudgetThreshold.enabled")}
            />
            Surveillance active
          </label>

          <Field
            label="Seuil d'alerte (% du budget)"
            htmlFor="alert-ai-threshold-percent"
            error={errors.aiBudgetThreshold?.thresholdPercent?.message}
            hint="Vide : 80 — l'alerte se résout d'elle-même si le dépassement prend le relais."
          >
            <input
              id="alert-ai-threshold-percent"
              className={inputClass}
              inputMode="decimal"
              autoComplete="off"
              placeholder="80"
              {...form.register("aiBudgetThreshold.thresholdPercent")}
            />
          </Field>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton label="Enregistrer les règles" pending={isSubmitting} />
      </div>

      <FormFeedback result={result} successMessage="Règles enregistrées." />
    </form>
  );
}
