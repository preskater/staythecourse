import type Decimal from "decimal.js";
import type { ReactElement } from "react";

/**
 * Invariant 7 (compile time) — no `Decimal` and no `Date` in the props of a client
 * component. A server component can only hand plain data to a `"use client"` module:
 * a `Decimal` arrives as a broken object, a `Date` as a string, and amounts or
 * calendar days silently change meaning on the way.
 *
 * Checked by `npm run typecheck` (CI), not by `npm test`: a component whose props
 * reach a `Decimal` or a `Date` makes `CLIENT_PROPS_ARE_PLAIN` stop compiling, and the
 * error names the module. `client-boundary.test.ts` checks that this list covers every
 * `"use client"` file.
 */

type IsAny<T> = 0 extends 1 & T ? true : false;

/** `true` when a Decimal or a Date can be reached from T. */
export type ReachesForbidden<T, Depth extends unknown[] = []> =
  IsAny<T> extends true
    ? false
    : Depth["length"] extends 6
      ? false
      : [T] extends [never]
        ? false
        : T extends Decimal | Date
          ? true
          : T extends ReactElement | ((...args: never[]) => unknown)
            ? false
            : T extends readonly (infer Item)[]
              ? ReachesForbidden<Item, [...Depth, unknown]>
              : T extends object
                ? true extends { [K in keyof T]-?: ReachesForbidden<T[K], [...Depth, unknown]> }[keyof T]
                  ? true
                  : false
                : false;

/** For each export of a module that is a component, whether its props are plain. */
export type ModuleIsPlain<M> = true extends {
  [K in keyof M]: M[K] extends (props: infer P) => unknown ? ReachesForbidden<P> : false;
}[keyof M]
  ? false
  : true;

export type ClientModules = {
  "src/app/(app)/account/change-password-form.tsx": typeof import("@/app/(app)/account/change-password-form");
  "src/app/(app)/account/session-buttons.tsx": typeof import("@/app/(app)/account/session-buttons");
  "src/app/(app)/alerts/dismiss-alert-button.tsx": typeof import("@/app/(app)/alerts/dismiss-alert-button");
  "src/app/(app)/alerts/refresh-alerts-button.tsx": typeof import("@/app/(app)/alerts/refresh-alerts-button");
  "src/app/(app)/alerts/rules-form.tsx": typeof import("@/app/(app)/alerts/rules-form");
  "src/app/(app)/budget/account-form.tsx": typeof import("@/app/(app)/budget/account-form");
  "src/app/(app)/budget/accounts-manager.tsx": typeof import("@/app/(app)/budget/accounts-manager");
  "src/app/(app)/budget/budget-form.tsx": typeof import("@/app/(app)/budget/budget-form");
  "src/app/(app)/budget/categories-manager.tsx": typeof import("@/app/(app)/budget/categories-manager");
  "src/app/(app)/budget/category-form.tsx": typeof import("@/app/(app)/budget/category-form");
  "src/app/(app)/budget/copy-budgets-button.tsx": typeof import("@/app/(app)/budget/copy-budgets-button");
  "src/app/(app)/budget/delete-budget-button.tsx": typeof import("@/app/(app)/budget/delete-budget-button");
  "src/app/(app)/budget/delete-goal-button.tsx": typeof import("@/app/(app)/budget/delete-goal-button");
  "src/app/(app)/budget/delete-recurring-button.tsx": typeof import("@/app/(app)/budget/delete-recurring-button");
  "src/app/(app)/budget/delete-transaction-button.tsx": typeof import("@/app/(app)/budget/delete-transaction-button");
  "src/app/(app)/budget/expense-simulation-modal.tsx": typeof import("@/app/(app)/budget/expense-simulation-modal");
  "src/app/(app)/budget/goal-contributions.tsx": typeof import("@/app/(app)/budget/goal-contributions");
  "src/app/(app)/budget/goal-form.tsx": typeof import("@/app/(app)/budget/goal-form");
  "src/app/(app)/budget/import/csv-importer.tsx": typeof import("@/app/(app)/budget/import/csv-importer");
  "src/app/(app)/budget/month-balance-chart.tsx": typeof import("@/app/(app)/budget/month-balance-chart");
  "src/app/(app)/budget/occurrence-actions.tsx": typeof import("@/app/(app)/budget/occurrence-actions");
  "src/app/(app)/budget/operations-table.tsx": typeof import("@/app/(app)/budget/operations-table");
  "src/app/(app)/budget/recurring-entry-form.tsx": typeof import("@/app/(app)/budget/recurring-entry-form");
  "src/app/(app)/budget/salary-booking-form.tsx": typeof import("@/app/(app)/budget/salary-booking-form");
  "src/app/(app)/budget/salary-booking-row.tsx": typeof import("@/app/(app)/budget/salary-booking-row");
  "src/app/(app)/budget/salary-form.tsx": typeof import("@/app/(app)/budget/salary-form");
  "src/app/(app)/budget/transaction-form.tsx": typeof import("@/app/(app)/budget/transaction-form");
  "src/app/(app)/budget/transfer-form.tsx": typeof import("@/app/(app)/budget/transfer-form");
  "src/app/(app)/budget/work-calendar.tsx": typeof import("@/app/(app)/budget/work-calendar");
  "src/app/(app)/integrations/issue-filters-form.tsx": typeof import("@/app/(app)/integrations/issue-filters-form");
  "src/app/(app)/modules/module-toggle.tsx": typeof import("@/app/(app)/modules/module-toggle");
  "src/app/(app)/real-estate/cashflow-form.tsx": typeof import("@/app/(app)/real-estate/cashflow-form");
  "src/app/(app)/real-estate/delete-event-button.tsx": typeof import("@/app/(app)/real-estate/delete-event-button");
  "src/app/(app)/real-estate/delete-loan-button.tsx": typeof import("@/app/(app)/real-estate/delete-loan-button");
  "src/app/(app)/real-estate/event-form.tsx": typeof import("@/app/(app)/real-estate/event-form");
  "src/app/(app)/real-estate/loan-form.tsx": typeof import("@/app/(app)/real-estate/loan-form");
  "src/app/(app)/real-estate/property-form.tsx": typeof import("@/app/(app)/real-estate/property-form");
  "src/app/(app)/real-estate/remove-property-button.tsx": typeof import("@/app/(app)/real-estate/remove-property-button");
  "src/app/(app)/real-estate/sale-form.tsx": typeof import("@/app/(app)/real-estate/sale-form");
  "src/app/(app)/real-estate/valuation-form.tsx": typeof import("@/app/(app)/real-estate/valuation-form");
  "src/components/forms.tsx": typeof import("@/components/forms");
  "src/components/keyboard-shortcuts.tsx": typeof import("@/components/keyboard-shortcuts");
  "src/components/main-nav.tsx": typeof import("@/components/main-nav");
  "src/components/ui/chart.tsx": typeof import("@/components/ui/chart");
};

type Offenders = {
  [File in keyof ClientModules]: ModuleIsPlain<ClientModules[File]> extends true ? never : File;
}[keyof ClientModules];

/** Fails to compile, naming the offending files, when a client prop reaches Decimal or Date. */
export const CLIENT_PROPS_ARE_PLAIN: [Offenders] extends [never] ? true : { offenders: Offenders } = true;

// Negative controls, also at compile time: the checker must see through nesting.
export const DETECTS_DECIMAL: ReachesForbidden<{ rows: { amount: Decimal }[] }> = true;
export const DETECTS_DATE: ReachesForbidden<{ initial: { day: Date | null } }> = true;
export const ACCEPTS_PLAIN: ReachesForbidden<{ amount: string; onSave: (value: Date) => void }> = false;

// End to end: a module exporting a component that takes a Decimal is reported.
export const DETECTS_MODULE: ModuleIsPlain<{
  Amount: (props: { value: Decimal }) => null;
  helper: string;
}> = false;
export const ACCEPTS_MODULE: ModuleIsPlain<{ Amount: (props: { value: string }) => null }> = true;
