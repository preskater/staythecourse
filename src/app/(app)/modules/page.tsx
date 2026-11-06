import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/guard";
import { MODULE_CATALOG, MODULE_KEYS, type ModuleKey } from "@/modules/catalog/catalog";
import { hasPermission } from "@/modules/identity/permissions";
import { ModuleToggle } from "./module-toggle";

export const dynamic = "force-dynamic";

/** What disabling each module with a page hides, beyond its own navigation entry. */
const CONSEQUENCES: Partial<Record<ModuleKey, string>> = {
  budget:
    "Comptes, opérations, budgets et objectifs disparaissent de la navigation, du tableau de bord, des alertes et des exports. L'immobilier ne propose plus de lier un flux à une opération.",
  "real-estate":
    "Biens, flux, prêts et échéances disparaissent de la navigation, du tableau de bord, des alertes et des exports.",
  development:
    "Les connexions GitHub et GitLab disparaissent de la navigation, du tableau de bord et des alertes ; la synchronisation manuelle n'est plus proposée.",
};

/**
 * « Modules » — what this workspace uses. Only the modules that have a page are listed:
 * the others in the catalog do not exist yet as features.
 */
export default async function ModulesPage() {
  const user = await requireUser();
  const { workspace } = user;
  const canManage = hasPermission(workspace.role, "manage-modules");
  const modules = MODULE_KEYS.filter((key) => MODULE_CATALOG[key].nav);

  return (
    <>
      <PageHeader
        title="Modules"
        description={`Modules actifs dans l'espace « ${workspace.name} ». Désactiver un module ne supprime rien : ses données sont conservées et réapparaissent dès sa réactivation.`}
      />

      {canManage ? null : (
        <Notice tone="info">
          Seuls le propriétaire et les administrateurs de l&apos;espace peuvent changer ses
          modules.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {modules.map((key) => {
          const { label, requires } = MODULE_CATALOG[key];
          const active = workspace.modules.includes(key);
          const dependants = MODULE_KEYS.filter(
            (other) => MODULE_CATALOG[other].requires.includes(key) && workspace.modules.includes(other),
          );

          return (
            <Card
              key={key}
              title={label}
              actions={
                canManage ? <ModuleToggle moduleKey={key} label={label} enabled={active} /> : null
              }
            >
              <div className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <p>
                  <Badge tone={active ? "positive" : "neutral"}>{active ? "Actif" : "Désactivé"}</Badge>
                </p>
                <p>
                  <strong>Prérequis :</strong>{" "}
                  {requires.length === 0
                    ? "aucun."
                    : `${requires.map((required) => MODULE_CATALOG[required].label).join(", ")}.`}
                </p>
                <p>
                  <strong>Si désactivé :</strong> {CONSEQUENCES[key]}
                  {dependants.length > 0
                    ? ` Désactive aussi : ${dependants.map((other) => MODULE_CATALOG[other].label).join(", ")}.`
                    : ""}
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
