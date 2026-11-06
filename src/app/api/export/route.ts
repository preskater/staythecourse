import { requireApiAccess } from "@/lib/auth/guard";
import { isExportEntity } from "@/lib/exports";
import { serveEntityExport, unknownEntityResponse } from "@/lib/export-route";

/**
 * CSV exports, selected by `?entity=`.
 *
 * `transactions`, `properties`, `budgets`, `goals` and `alerts` are the supported
 * entities; anything else — a missing value, a typo, `all` — answers 400 and reads
 * nothing. Each entity keeps its own route (`/api/export/transactions`, ...) for the
 * links already in the interface: both paths call the same builder, so the guards,
 * filters and audit entry are identical.
 *
 * The entity is a code, never a path or a table name: the dispatch is a `switch` over a
 * closed union, so no query string can reach a read that is not part of the catalogue.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const user = await requireApiAccess("export");

  if (user instanceof Response) {
    return user;
  }

  const entity = new URL(request.url).searchParams.get("entity");

  if (!isExportEntity(entity)) {
    return unknownEntityResponse();
  }

  return serveEntityExport(user, request, entity);
}
