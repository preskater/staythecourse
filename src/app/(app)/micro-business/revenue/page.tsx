import Decimal from "decimal.js";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  StatCard,
  TableShell,
  tdClass,
  thClass,
} from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { formatDateOnly, formatMonthLabel, toDateOnlyString, todayDateOnly } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { formatMoney, type Currency } from "@/lib/money";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import { billingBehaviour } from "@/modules/micro-business/domain";
import { listProjects, listRevenueDocuments } from "@/modules/micro-business/repository";
import {
  REVENUE_DOCUMENT_KIND_LABELS,
  REVENUE_STATUS_LABELS,
  revenueMonthEntries,
  statementOf,
  summariseRevenueMonth,
  type RevenueDocumentRecord,
  type RevenueStatement,
  type RevenueStatus,
} from "@/modules/micro-business/revenue";
import { MicroBusinessTabs } from "../micro-business-tabs";
import { RevenueDocumentForm } from "./revenue-form";
import { RevenueMovementForm } from "./revenue-movement-form";

export const dynamic = "force-dynamic";

function statusTone(status: RevenueStatus): "neutral" | "positive" | "negative" | "warning" {
  switch (status) {
    case "PAID":
      return "positive";
    case "OVERDUE":
      return "negative";
    case "PARTIALLY_PAID":
      return "warning";
    default:
      return "neutral";
  }
}

function money(amount: Decimal, currency: RevenueStatement["currency"]): string {
  return formatMoney({ amount, currency });
}

/** The label of a document in a select: project, issue day and current balance. */
function invoiceOptionLabel(
  document: RevenueDocumentRecord,
  statement: RevenueStatement,
): string {
  return `${document.projectName} · ${formatDateOnly(document.issuedOn)} · reste dû ${money(statement.outstanding, document.currency)}`;
}

/**
 * « Revenus » — invoices, credit notes, payments, refunds and write-offs.
 *
 * Every status is derived when the page renders: a due date is compared with the
 * owner's current calendar day, and the amounts are the sums of the stored rows. No
 * status column exists to go stale. The month summary is deliberately empty when the
 * month holds no movement — "no data" is not a row of zeros.
 */
export default async function RevenuePage() {
  const user = await requireUser();

  if (!hasModule(user.workspace, "micro-business")) {
    return <ModuleDisabled moduleKey="micro-business" workspace={user.workspace} />;
  }

  const canManage = canManageBusinessRecords(user.workspace.role);
  const [projects, documents] = await Promise.all([
    listProjects(user.workspace.id),
    listRevenueDocuments(user.workspace.id),
  ]);

  const asOf = todayDateOnly(publicEnv.NEXT_PUBLIC_DEFAULT_TIME_ZONE);
  const today = toDateOnlyString(asOf);
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth() + 1;

  const invoices = documents.filter((document) => document.kind === "INVOICE");
  const statements = new Map(
    invoices.map((invoice) => [invoice.id, statementOf(invoice, asOf)]),
  );

  const outstandingTotals = new Map<Currency, Decimal>();
  let openCount = 0;
  let overdueCount = 0;

  for (const statement of statements.values()) {
    if (statement.outstanding.greaterThan(0)) {
      openCount += 1;
      outstandingTotals.set(
        statement.currency,
        (outstandingTotals.get(statement.currency) ?? new Decimal(0)).plus(
          statement.outstanding,
        ),
      );
    }
    if (statement.status === "OVERDUE") {
      overdueCount += 1;
    }
  }

  const outstandingLabel =
    [...outstandingTotals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, total]) => money(total, currency))
      .join(" · ") || "—";

  const projectOptions = projects
    .filter(
      (project) =>
        !project.archived &&
        billingBehaviour(project.billingModel).billable &&
        project.clientId !== null,
    )
    .map((project) => ({
      id: project.id,
      name: project.name,
      clientName: project.clientName ?? "—",
      currency: project.currency,
    }));

  const creditNoteOptions = invoices
    .filter((invoice) => statements.get(invoice.id)!.outstanding.greaterThan(0))
    .map((invoice) => ({
      id: invoice.id,
      label: invoiceOptionLabel(invoice, statements.get(invoice.id)!),
    }));

  const movementOptions = invoices
    .filter((invoice) => {
      const statement = statements.get(invoice.id)!;
      return statement.outstanding.greaterThan(0) || statement.paid.greaterThan(0);
    })
    .map((invoice) => ({
      id: invoice.id,
      label: invoiceOptionLabel(invoice, statements.get(invoice.id)!),
    }));

  const summary = summariseRevenueMonth(revenueMonthEntries(documents), year, month);

  return (
    <>
      <PageHeader
        title="Revenus"
        description="Factures, avoirs, encaissements, remboursements et mises en perte. Le statut est recalculé à chaque lecture à partir des mouvements datés : rien ne se fige. Un trop-perçu est refusé ; un avoir est le chemin explicite pour réduire une facture. Les devises ne sont jamais converties."
      />

      <MicroBusinessTabs current="/micro-business/revenue" />

      {canManage ? null : (
        <Notice tone="info">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent enregistrer
          des revenus. Vous pouvez consulter les documents existants.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Factures en cours" value={String(openCount)} />
        <StatCard
          label="En retard"
          value={String(overdueCount)}
          tone={overdueCount > 0 ? "negative" : "neutral"}
        />
        <StatCard
          label="Reste dû"
          value={outstandingLabel}
          hint="Toutes devises, sans conversion."
        />
      </div>

      {canManage ? (
        <Card
          id="revenue-document-form"
          title="Nouvelle facture ou avoir"
          description="Une facture facturable exige un projet doté d'un client. Un avoir se rattache à une facture et ne peut pas dépasser son reste dû."
        >
          <RevenueDocumentForm
            projects={projectOptions}
            invoices={creditNoteOptions}
            today={today}
          />
        </Card>
      ) : null}

      {canManage ? (
        <Card
          id="revenue-movement-form"
          title="Encaissement, remboursement ou mise en perte"
          description="Chaque mouvement est daté et s'ajoute à la facture choisie. Le montant ne peut jamais dépasser le reste dû (ou le net encaissé pour un remboursement)."
        >
          <RevenueMovementForm invoices={movementOptions} today={today} />
        </Card>
      ) : null}

      <Card
        title={`Mouvements de ${formatMonthLabel(year, month)}`}
        description="Facturé, reconnu, encaissé et passé en perte pour le mois en cours, par devise. Un mois sans mouvement n'affiche aucun chiffre plutôt qu'un zéro trompeur."
      >
        {summary.length === 0 ? (
          <EmptyState
            title="Aucun mouvement ce mois-ci"
            description="Les chiffres apparaîtront dès la première facture, reconnaissance, encaissement, remboursement ou mise en perte daté de ce mois."
          />
        ) : (
          <TableShell caption="Mouvements du mois par devise">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Devise
                </th>
                <th scope="col" className={thClass}>
                  Facturé
                </th>
                <th scope="col" className={thClass}>
                  Reconnu
                </th>
                <th scope="col" className={thClass}>
                  Encaissé
                </th>
                <th scope="col" className={thClass}>
                  Passé en perte
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.map((total) => (
                <tr key={total.currency}>
                  <td className={tdClass}>{total.currency}</td>
                  <td className={tdClass}>{money(total.issued, total.currency)}</td>
                  <td className={tdClass}>{money(total.recognized, total.currency)}</td>
                  <td className={tdClass}>{money(total.paid, total.currency)}</td>
                  <td className={tdClass}>{money(total.writtenOff, total.currency)}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title="Documents"
        description="Une facture listée avec son reste dû et son statut dérivé ; un avoir réduit la facture qu'il nomme. Les montants reconnus restent ceux saisis, même après un avoir ou un encaissement."
      >
        {documents.length === 0 ? (
          <EmptyState
            title="Aucun document de revenu"
            description="Enregistrez une première facture pour suivre les encaissements et les échéances."
          />
        ) : (
          <TableShell caption="Factures et avoirs">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Document
                </th>
                <th scope="col" className={thClass}>
                  Projet / client
                </th>
                <th scope="col" className={thClass}>
                  Dates
                </th>
                <th scope="col" className={thClass}>
                  Montant
                </th>
                <th scope="col" className={thClass}>
                  Encaissé
                </th>
                <th scope="col" className={thClass}>
                  Reste dû
                </th>
                <th scope="col" className={thClass}>
                  Statut
                </th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const statement =
                  document.kind === "INVOICE" ? statements.get(document.id)! : null;

                return (
                  <tr key={document.id}>
                    <td className={tdClass}>
                      <span className="font-medium">
                        {REVENUE_DOCUMENT_KIND_LABELS[document.kind]}
                      </span>
                      {document.kind === "CREDIT_NOTE" && document.creditNoteFor ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          sur facture du {formatDateOnly(document.creditNoteFor.issuedOn)}
                        </span>
                      ) : null}
                      {document.notes ? (
                        <span className="block max-w-56 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {document.notes}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {document.projectName}
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {document.clientName ?? "Sans client"}
                      </span>
                    </td>
                    <td className={tdClass}>
                      Émise le {formatDateOnly(document.issuedOn)}
                      {document.dueOn ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          Échéance {formatDateOnly(document.dueOn)}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {money(document.amount, document.currency)}
                      {document.recognizedOn && document.recognizedAmount ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          Reconnu le {formatDateOnly(document.recognizedOn)} :{" "}
                          {money(document.recognizedAmount, document.currency)}
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {statement ? money(statement.paid, document.currency) : "—"}
                    </td>
                    <td className={tdClass}>
                      {statement ? money(statement.outstanding, document.currency) : "—"}
                    </td>
                    <td className={tdClass}>
                      {statement ? (
                        <>
                          <Badge tone={statusTone(statement.status)}>
                            {REVENUE_STATUS_LABELS[statement.status]}
                          </Badge>
                          {statement.overdueDays > 0 ? (
                            <span className="block text-xs text-rose-700 dark:text-rose-400">
                              {statement.overdueDays} j de retard
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          Réduction
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>
    </>
  );
}
