import type Decimal from "decimal.js";
import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { formatDateOnly } from "@/lib/dates";
import { DEFAULT_CURRENCY, formatMoney, type Currency } from "@/lib/money";
import {
  LOAN_INSURANCE_MODE_LABELS,
  LOAN_PURPOSE_LABELS,
  monthlyInsuranceCost,
  toLoanFormValues,
  type LoanSummary,
} from "@/modules/loans/domain";
import { findLoan } from "@/modules/loans/repository";
import { listLoanGroups } from "@/modules/loans/service";
import { listPropertyOptions } from "@/modules/real-estate/repository";
import { LoanArchiveButton } from "./loan-archive-button";
import { LoanForm } from "./loan-form";

const RATE_FORMAT = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

/** An unknown financing figure reads "non renseigné", never 0 or 0 %. */
function formatRate(rate: Decimal | null): string {
  return rate === null ? "non renseigné" : `${RATE_FORMAT.format(rate.toNumber())} %`;
}

function formatAmount(amount: Decimal | null, currency: Currency): string {
  return amount === null ? "non renseigné" : formatMoney({ amount, currency });
}

function insuranceLabel(loan: LoanSummary): string {
  if (loan.insuranceMode === null) {
    return "non renseigné";
  }

  const mode = LOAN_INSURANCE_MODE_LABELS[loan.insuranceMode];

  switch (loan.insuranceMode) {
    case "NONE":
      return "Aucune";
    case "FIXED_MONTHLY":
      return loan.insuranceMonthlyAmount === null
        ? `${mode} — non renseigné`
        : `${formatMoney({ amount: loan.insuranceMonthlyAmount, currency: loan.currency })} / mois`;
    case "RATE_OF_PRINCIPAL":
      return `${formatRate(loan.insuranceRate)} du capital`;
    case "RATE_OF_BALANCE":
      return `${formatRate(loan.insuranceRate)} du solde`;
  }
}

function monthlyCostLabel(loan: LoanSummary): string {
  const cost = monthlyInsuranceCost(loan);

  if (cost === null) {
    return "non renseigné";
  }

  return `${formatMoney({ amount: cost, currency: loan.currency })} / mois`;
}

/**
 * « Prêts » — the workspace loan registry (M21-01), rendered as a budget tab.
 *
 * The parent page has already checked the session, the budget entitlement and the
 * role permission; this section reads only the session's workspace and never trusts
 * an identifier coming from the URL. Every loan is grouped by currency and never
 * added to another currency's figures. The monthly cost shown is the insurance cost
 * only: no amortisation schedule and no simulated instalment is computed here
 * (M21-02 owns that).
 */
export async function LoansSection({
  workspaceId,
  canLinkProperty,
  editLoanId,
}: {
  workspaceId: string;
  /** Real-estate entitlement, resolved by the page from the session's workspace. */
  canLinkProperty: boolean;
  /** `?editLoan=` — an identifier to look up, never an authorisation. */
  editLoanId?: string | null;
}) {
  const [groups, properties, editingLoan] = await Promise.all([
    listLoanGroups(workspaceId),
    canLinkProperty ? listPropertyOptions(workspaceId) : Promise.resolve([]),
    editLoanId ? findLoan(workspaceId, editLoanId) : Promise.resolve(null),
  ]);

  const defaultCurrency = groups[0]?.currency ?? DEFAULT_CURRENCY;
  const propertyLinkLocked = !canLinkProperty && Boolean(editingLoan?.propertyId);
  const editValues = editingLoan ? toLoanFormValues(editingLoan) : null;
  const loanCount = groups.reduce((total, group) => total + group.loans.length, 0);

  return (
    <>
      <Card
        title={editingLoan ? `Modifier « ${editingLoan.label} »` : "Nouveau prêt"}
        description={
          editingLoan
            ? "Les champs laissés vides restent « non renseignés ». Archiver un prêt le retire des formulaires de sélection sans effacer son historique."
            : "Un taux, une durée, une assurance ou un solde inconnus restent vides : ils sont enregistrés « non renseignés », jamais à zéro."
        }
        actions={
          editingLoan ? (
            <Link
              href="/budget?tab=loans"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Annuler la modification
            </Link>
          ) : null
        }
      >
        <LoanForm
          key={editingLoan?.id ?? "new"}
          properties={properties}
          loan={editValues}
          propertyLinkLocked={propertyLinkLocked}
          propertyName={editingLoan?.propertyName ?? null}
          defaultCurrency={defaultCurrency}
        />
      </Card>

      {!canLinkProperty ? (
        <Notice tone="info">
          Le module Immobilier n&apos;est pas actif dans cet espace : un prêt peut être
          enregistré sans bien, et un lien existant reste conservé.
        </Notice>
      ) : null}

      {loanCount === 0 ? (
        <EmptyState
          title="Aucun prêt enregistré"
          description="Ajoutez un crédit pour suivre son capital, son taux, sa durée et son assurance. Rien n'est calculé à votre place : les valeurs inconnues restent explicitement non renseignées."
        />
      ) : (
        groups.map((group) => (
          <Card
            key={group.currency}
            title={`Prêts en ${group.currency}`}
            description={`${group.activeCount} actif${group.activeCount > 1 ? "s" : ""}, ${group.archivedCount} archivé${group.archivedCount > 1 ? "s" : ""}. Aucun total n'est additionné à une autre devise.`}
          >
            <TableShell caption={`Prêts en ${group.currency}`}>
              <thead>
                <tr>
                  <th scope="col" className={thClass}>
                    Prêt
                  </th>
                  <th scope="col" className={thClass}>
                    Objet
                  </th>
                  <th scope="col" className={thClass}>
                    Capital
                  </th>
                  <th scope="col" className={thClass}>
                    Taux
                  </th>
                  <th scope="col" className={thClass}>
                    Durée
                  </th>
                  <th scope="col" className={thClass}>
                    Assurance
                  </th>
                  <th scope="col" className={thClass}>
                    Coût mensuel (assurance)
                  </th>
                  <th scope="col" className={thClass}>
                    Solde
                  </th>
                  <th scope="col" className={thClass}>
                    État
                  </th>
                  <th scope="col" className={thClass}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.loans.map((loan) => (
                  <tr key={loan.id} className={loan.archived ? "opacity-60" : undefined}>
                    <td className={tdClass}>
                      <span className="font-medium">{loan.label}</span>
                      {loan.lender ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {loan.lender}
                        </span>
                      ) : null}
                      {loan.propertyName ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          Bien : {loan.propertyName}
                        </span>
                      ) : null}
                      {loan.notes ? (
                        <span
                          className="block max-w-64 truncate text-xs text-zinc-500 dark:text-zinc-400"
                          title={loan.notes}
                        >
                          {loan.notes}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>{LOAN_PURPOSE_LABELS[loan.purpose]}</td>
                    <td className={`${tdClass} tabular-nums`}>
                      {formatMoney({ amount: loan.initialPrincipal, currency: loan.currency })}
                      {loan.fees === null ? null : (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          Frais : {formatMoney({ amount: loan.fees, currency: loan.currency })}
                        </span>
                      )}
                    </td>
                    <td className={`${tdClass} tabular-nums`}>{formatRate(loan.annualRate)}</td>
                    <td className={tdClass}>
                      {loan.termMonths === null ? "non renseigné" : `${loan.termMonths} mois`}
                      {loan.interestOnlyMonths > 0 ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          dont {loan.interestOnlyMonths} mois de différé
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>{insuranceLabel(loan)}</td>
                    <td className={`${tdClass} tabular-nums`}>{monthlyCostLabel(loan)}</td>
                    <td className={`${tdClass} tabular-nums`}>
                      {formatAmount(loan.outstandingBalance, loan.currency)}
                      {loan.balanceAsOf ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          au {formatDateOnly(loan.balanceAsOf)}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {loan.archived ? (
                        <Badge tone="warning">Archivé</Badge>
                      ) : (
                        <Badge tone="positive">Actif</Badge>
                      )}
                    </td>
                    <td className={tdClass}>
                      <span className="flex flex-col items-start gap-1">
                        <Link
                          href={`/budget?tab=loans&editLoan=${encodeURIComponent(loan.id)}`}
                          className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Modifier
                        </Link>
                        <LoanArchiveButton
                          loanId={loan.id}
                          label={loan.label}
                          archived={loan.archived}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
        ))
      )}

      <Notice tone="info">
        Les prêts archivés restent lisibles ici et peuvent être restaurés, mais ils ne
        sont plus proposés dans les formulaires de sélection. Aucun prêt n&apos;est
        supprimé : un prêt lié à un bien ou à d&apos;autres enregistrements garde son
        historique.
      </Notice>
    </>
  );
}
