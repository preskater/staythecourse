import Link from "next/link";
import { Notice, PageHeader } from "@/components/ui";
import { MODULE_CATALOG, type ModuleKey } from "@/modules/catalog/catalog";
import { hasPermission } from "@/modules/identity/permissions";
import type { ActiveWorkspace } from "@/modules/identity/workspace";

/**
 * What a direct link to an inactive module shows instead of a 404: the state is
 * explained, and nothing from the module has been read to render it.
 */
export function ModuleDisabled({
  moduleKey,
  workspace,
}: {
  moduleKey: ModuleKey;
  workspace: Pick<ActiveWorkspace, "name" | "role">;
}) {
  const { label } = MODULE_CATALOG[moduleKey];

  return (
    <>
      <PageHeader title={label} />
      <Notice tone="info">
        Le module « {label} » n&apos;est pas actif dans l&apos;espace « {workspace.name} ».
        Ses données sont conservées telles quelles et réapparaîtront dès sa réactivation.{" "}
        {hasPermission(workspace.role, "manage-modules") ? (
          <Link href="/modules" className="underline underline-offset-2">
            Gérer les modules
          </Link>
        ) : (
          "Seuls le propriétaire et les administrateurs de l'espace peuvent le réactiver."
        )}
      </Notice>
    </>
  );
}
