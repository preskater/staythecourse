import { Card } from "@/components/ui";
import type { AccountSummary, CategorySummary } from "@/modules/budget/domain";
import { TransactionForm } from "./transaction-form";

/**
 * Quick entry for the dashboard (UX-02).
 *
 * It renders the budget page's own `TransactionForm`, not a lighter copy: the same Zod
 * schema, the same `createTransactionAction` (and its `requireModule("budget", "write")`), the same
 * revalidation and feedback. A convenience path must never be a weaker write path.
 */
export function QuickTransactionCard({
  accounts,
  categories,
  labelSuggestions,
  today,
}: {
  accounts: AccountSummary[];
  categories: CategorySummary[];
  labelSuggestions: string[];
  today: string;
}) {
  return (
    <Card
      title="Nouvelle opération"
      description="Saisie rapide, identique au formulaire de la page Budget. Raccourci : touche n."
      collapsible
    >
      <TransactionForm
        accounts={accounts}
        categories={categories}
        labelSuggestions={labelSuggestions}
        today={today}
      />
    </Card>
  );
}
