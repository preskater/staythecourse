import Link from "next/link";
import { ActionMenu, type ActionMenuGroup } from "@/components/action-menu";
import {
	Badge,
	Card,
	EmptyState,
	Notice,
	PageHeader,
	StatCard,
} from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { formatInstant, toDateOnlyString } from "@/lib/dates";
import { publicEnv } from "@/lib/env";
import { formatMoney } from "@/lib/money";
import { refreshAlerts } from "@/modules/alerts/refresh";
import { describeBudgetVariance } from "@/modules/budget/report";
import { listAccounts, listCategories, listLabelHistory } from "@/modules/budget/repository";
import { buildLabelSuggestions } from "@/modules/budget/suggestions";
import { getDashboardOverview } from "@/modules/dashboard/queries";
import { QuickTransactionCard } from "../budget/quick-transaction-card";

// Personal financial data must never be served from a static cache.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
	const user = await requireUser();

	// One bounded evaluation pass before reading anything: the warnings below describe the
	// data of this visit, and the pass never writes to the ledger. The alert page runs the
	// same pass, so both screens tell the same story.
	await refreshAlerts(user.workspace.id);

	// Only the active modules are read and shown; the others leave no card behind.
	const budgetActive = user.workspace.modules.includes("budget");
	const [overview, accounts, categories, labelHistory] = await Promise.all([
		getDashboardOverview(user.workspace.id, { modules: user.workspace.modules }),
		// The quick entry reads the same lists as the budget page's form, from the owner's data.
		budgetActive ? listAccounts(user.workspace.id) : [],
		budgetActive ? listCategories(user.workspace.id) : [],
		budgetActive ? listLabelHistory(user.workspace.id) : [],
	]);

	const { alerts, budget, budgetTracking, realEstate, integrations, monthKey, monthLabel } =
		overview;
	const noModule = !budget && !realEstate && !integrations;

	// The header keeps one primary gesture and one menu: three side-by-side buttons
	// wrapped onto two rows and read like a toolbar rather than a page title.
	const exportActions: ActionMenuGroup[] = [
		{
			label: "Exporter",
			items: [
				...(budget
					? [
							{
								href: "/api/export/transactions",
								label: "Transactions (CSV)",
								hint: `Opérations de ${monthLabel}`,
							},
						]
					: []),
				{
					href: "/api/export/summary",
					label: "Synthèse de situation (.md)",
					hint: "Document complet, lisible par un assistant",
				},
				...(budget
					? [
							{
								href: "/api/export/summary?scope=finance",
								label: "Situation financière seule (.md)",
								hint: "Budget uniquement",
							},
						]
					: []),
			],
		},
	];

	return (
		<>
			<PageHeader
				title="Tableau de bord"
				description={`Indicateurs de ${monthLabel}. Chaque total est calculé à partir des opérations enregistrées.`}
				actions={
					noModule ? null : (
						<>
							{budget ? (
								<Link
									href="/budget"
									className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
								>
									Saisir une opération
								</Link>
							) : null}
							<ActionMenu label="Actions" groups={exportActions} />
						</>
					)
				}
			/>

			{alerts.active.length > 0 ? (
				<section aria-labelledby="alertes-actives" className="flex flex-col gap-2">
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<h2
							id="alertes-actives"
							className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
						>
							Alertes — {alerts.active.length} active{alerts.active.length > 1 ? "s" : ""}
						</h2>
						<Link
							href="/alerts"
							className="text-sm underline-offset-2 hover:underline"
						>
							Règles et historique
						</Link>
					</div>

					{alerts.active.slice(0, 3).map((alert) => (
						<Notice
							key={alert.id}
							tone={alert.tone === "negative" ? "error" : "warning"}
						>
							<strong>{alert.title} :</strong> {alert.reason}
						</Notice>
					))}

					{alerts.active.length > 3 ? (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							+ {alerts.active.length - 3} autre{alerts.active.length - 3 > 1 ? "s" : ""} — voir
							la page Alertes.
						</p>
					) : null}
				</section>
			) : null}

			{noModule ? (
				<Notice tone="info">
					Aucun module n&apos;est actif dans l&apos;espace « {user.workspace.name} » : le tableau
					de bord n&apos;a rien à afficher.{" "}
					<Link href="/modules" className="underline underline-offset-2">
						Voir les modules
					</Link>
					.
				</Notice>
			) : null}

			{budget ? (
				<QuickTransactionCard
					accounts={accounts}
					categories={categories}
					labelSuggestions={buildLabelSuggestions(labelHistory)}
					today={toDateOnlyString(new Date())}
				/>
			) : null}

			{budget && budgetTracking ? (
				<section aria-labelledby="budget-month" className="flex flex-col gap-3">
					<h2
						id="budget-month"
						className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
					>
						Budget — {monthLabel}
					</h2>

					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
								Suivi du budget — {monthLabel}
							</h3>
							<Link
								href={`/budget?month=${monthKey}&tab=report`}
								className="text-sm underline-offset-2 hover:underline"
							>
								Détail par catégorie
							</Link>
						</div>

						{budgetTracking.totals.length === 0 ? (
							<Notice tone="info">
								Aucun budget n&apos;est défini pour {monthLabel} : il n&apos;y a rien à
								comparer, ce qui n&apos;est pas la même chose qu&apos;un suivi à zéro.{" "}
								<Link
									href={`/budget?month=${monthKey}&tab=budgets`}
									className="underline underline-offset-2"
								>
									Définir les budgets
								</Link>
								.
							</Notice>
						) : (
							<>
								{budgetTracking.truncated ? (
									<Notice tone="warning">
										Le mois dépasse la limite de lecture : le réalisé du suivi est
										partiel et les écarts peuvent être sous-estimés.
									</Notice>
								) : null}

								<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
									{budgetTracking.totals.map((total) => {
										const variance = describeBudgetVariance(total);

										return (
											<StatCard
												key={`${total.currency}|${total.categoryKind}`}
												label={
													total.categoryKind === "EXPENSE"
														? `Budget dépenses (${total.currency})`
														: `Objectif recettes (${total.currency})`
												}
												value={formatMoney({
													amount: total.remaining,
													currency: total.currency,
												})}
												tone={variance.tone}
												hint={`Prévu ${formatMoney({
													amount: total.planned,
													currency: total.currency,
												})} · réalisé ${formatMoney({
													amount: total.actual,
													currency: total.currency,
												})}`}
											/>
										);
									})}
								</div>

								<p className="text-xs text-zinc-500 dark:text-zinc-400">
									Le reste compare les budgets aux opérations du mois rattachées à
									une catégorie budgétée : transferts et opérations sans catégorie
									exclus, devises jamais converties. Un reste négatif sur les dépenses
									signale un dépassement.
								</p>
							</>
						)}
					</div>

					<StatCard
						label={`Solde cumulé (${budget.monthTotals[0]?.currency ?? publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY})`}
						value={formatMoney({
							amount: budget.totalCumulative,
							currency: budget.monthTotals[0]?.currency ?? publicEnv.NEXT_PUBLIC_DEFAULT_CURRENCY,
						})}
						hint="Solde cumulé depuis le début de l'historique."
					/>

					{budget.monthTotals.length === 0 ? (
						<EmptyState
							title="Aucune opération sur ce mois"
							description={
								budget.transactionCount > 0
									? "Des opérations existent sur d'autres mois. Aucun solde n'est affiché ici pour ne pas laisser croire à un mois à zéro."
									: "Aucune donnée n'a encore été saisie. Le budget se remplit d'abord avec un compte, puis des opérations."
							}
							action={
								<Link
									href="/budget"
									className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
								>
									Ouvrir le budget
								</Link>
							}
						/>
					) : (
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							{budget.monthTotals.map((totals) => (
								<div key={totals.currency} className="contents">
									<StatCard
										label={`Recettes (${totals.currency})`}
										value={formatMoney({
											amount: totals.income,
											currency: totals.currency,
										})}
									/>
									<StatCard
										label={`Dépenses (${totals.currency})`}
										value={formatMoney({
											amount: totals.expenses,
											currency: totals.currency,
										})}
									/>
									<StatCard
										label={`Solde (${totals.currency})`}
										value={formatMoney({
											amount: totals.net,
											currency: totals.currency,
										})}
										tone={totals.net.isNegative() ? "negative" : "positive"}
										hint="Transferts inclus."
									/>
									<StatCard
										label={`Transferts (${totals.currency})`}
										value={formatMoney({
											amount: totals.transfers,
											currency: totals.currency,
										})}
										hint="Volume déplacé, déjà compris dans les deux cartes ci-dessus."
									/>
								</div>
							))}
						</div>
					)}

					<Notice tone="info">
						Le solde mensuel <strong>compte les transferts entre comptes</strong>{" "}
						selon leur signe : un transfert négatif est une sortie, un transfert
						positif une entrée. Leur volume est affiché à part, et déjà compris
						dans les recettes et les dépenses.
					</Notice>
				</section>
			) : null}

			{integrations?.some((integration) => integration.stale) ? (
				<Notice tone="warning">
					Certaines connexions n&apos;ont plus été synchronisées depuis plus de 24 h.
					Les données affichées restent les dernières lues, mais elles peuvent avoir vieilli.
				</Notice>
			) : null}

			<div className="grid gap-4 lg:grid-cols-2">
				{realEstate ? (
					<Card title="Immobilier" description="Biens suivis et flux rattachés.">
						{realEstate.propertyCount === 0 ? (
							<EmptyState
								title="Aucun bien enregistré"
								description="Ajoutez un bien pour suivre ses charges, ses recettes et ses échéances."
								action={
									<Link
										href="/real-estate"
										className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
									>
										Gérer l&apos;immobilier
									</Link>
								}
							/>
						) : (
							<p className="text-sm text-zinc-700 dark:text-zinc-300">
								{realEstate.propertyCount} bien
								{realEstate.propertyCount > 1 ? "s" : ""} suivi
								{realEstate.propertyCount > 1 ? "s" : ""}. Le détail des charges
								et des recettes est disponible dans la section Immobilier.
							</p>
						)}
					</Card>
				) : null}

				{integrations ? (
					<Card
						title="Connexions GitHub et GitLab"
						description="Lecture seule. Aucun secret n'est exposé à l'interface."
					>
						{integrations.length === 0 ? (
							<EmptyState
								title="Non connecté"
								description="Aucune connexion n'est configurée. Les projets ne sont donc pas affichés : ce n'est pas la même chose qu'un projet sans activité."
								action={
									<Link
										href="/integrations"
										className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
									>
										Configurer une connexion
									</Link>
								}
							/>
						) : (
							<ul className="flex flex-col gap-2 text-sm">
								{integrations.map(({ connection, state, stale }) => (
									<li
										key={connection.id}
										className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 pb-2 last:border-0 dark:border-zinc-800"
									>
										<span className="font-medium">
											{connection.provider}
											<span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
												{connection.externalOwner ?? "compte complet"}
											</span>
										</span>

										{state.kind === "CONNECTED" ? (
											<Badge tone={stale ? "warning" : "positive"}>
												{state.projectCount === 0
													? "Aucun projet suivi"
													: `${state.projectCount} projet${state.projectCount > 1 ? "s" : ""}`}{" "}
												— {formatInstant(state.lastSyncedAt)}
												{stale ? " — données anciennes" : ""}
											</Badge>
										) : state.kind === "ERROR" ? (
											<Badge tone="negative">
												Erreur de synchronisation
												{state.lastSyncError ? ` (${state.lastSyncError})` : ""}
											</Badge>
										) : state.kind === "NEVER_SYNCED" ? (
											<Badge tone="warning">Jamais synchronisé</Badge>
										) : (
											<Badge>Non connecté</Badge>
										)}
									</li>
								))}
							</ul>
						)}
					</Card>
				) : null}
			</div>

			{noModule ? null : (
				<Card
					title="Synthèse de situation"
					description="Un document Markdown unique — comptes, réalisé, budgets, séries récurrentes, prévisions, salaire simulé, échéancier des mois à venir, épargne, objectifs, immobilier, micro-entreprise, intégrations et alertes — lisible tel quel ou transmissible à un assistant. Il ne contient aucune recommandation et ne lit que les données enregistrées ici."
				>
					<div className="flex flex-col gap-3">
						<div>
							<Link
								href="/api/export/summary"
								className="inline-flex rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
							>
								Télécharger la synthèse (.md)
							</Link>
						</div>
						<p className="text-xs text-zinc-500 dark:text-zinc-400">
							Le document cite son mois de référence et son horizon (6 mois par défaut), indique
							les sections absentes — module inactif ou périmètre réduit — et distingue
							« inconnu » d&apos;un zéro. Un bloc « Comment lire ce document » fixe les
							conventions de signes, de devises et de dates. Le fichier est généré à la demande
							et l&apos;export est inscrit au journal d&apos;audit. Le périmètre
							« finances seules » est disponible depuis le menu Actions.
						</p>
					</div>
				</Card>
			)}
		</>
	);
}
