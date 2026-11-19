import { Card, Notice, PageHeader } from "@/components/ui";
import { ModuleDisabled } from "@/components/module-disabled";
import { requireUser } from "@/lib/auth/guard";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { listCostImportMappings } from "@/modules/ai-costs/repository";
import { hasModule } from "@/modules/catalog/catalog";
import { canManageBusinessRecords } from "@/modules/identity/workspace";
import { CostCsvImporter } from "./cost-csv-importer";

export const dynamic = "force-dynamic";

/**
 * CSV import of cost entries (`/ai-costs/import`, M9-05).
 *
 * The file is parsed in the browser and never uploaded: only normalised rows reach the
 * Server Action, first for a preview (nothing written), then for the import. Saved
 * mappings hold column headers and settings, never file content.
 */
export default async function CostImportPage() {
  const user = await requireUser();

  if (!hasModule(user.workspace, "ai-costs")) {
    return <ModuleDisabled moduleKey="ai-costs" workspace={user.workspace} />;
  }

  const canImport = canManageBusinessRecords(user.workspace.role);
  const mappings = canImport ? await listCostImportMappings(user.workspace.id) : [];

  return (
    <>
      <PageHeader
        title="Importer des coûts (CSV)"
        description="Exports de fournisseurs et factures. Le fichier est analysé dans votre navigateur ; seules les lignes normalisées sont envoyées, d'abord pour un aperçu sans écriture, puis pour l'import."
      />

      {canImport ? (
        <>
          <Card
            title="Fichier à importer"
            description="Montant signé : positif pour un coût, négatif pour un avoir ou un remboursement. Au-delà de deux décimales, le montant est arrondi au centime (demi supérieur) et l'aperçu le signale. La devise vient de la colonne « Devise », sinon de la devise par défaut : aucune conversion n'est faite."
          >
            <CostCsvImporter
              mappings={mappings}
              currencies={[...SUPPORTED_CURRENCIES]}
            />
          </Card>

          <Card
            title="Comment les doublons sont détectés"
            description="Une ligne est reconnue par sa source et sa référence (n° de facture, ID de ligne) quand le fichier en a une ; sinon par sa période, sa devise, son montant et son libellé. Réimporter le même fichier ne crée donc rien. Sans référence, deux lignes identiques d'un même fichier comptent pour un seul coût : la seconde est signalée comme doublon."
          >
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Renommer une source change l&apos;identité de ses lignes : gardez le même nom
              d&apos;un import à l&apos;autre. Chaque import est tracé dans le journal
              d&apos;audit (compteurs uniquement, jamais le contenu des lignes).
            </p>
          </Card>
        </>
      ) : (
        <Notice tone="warning">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent importer des
          coûts.
        </Notice>
      )}
    </>
  );
}
