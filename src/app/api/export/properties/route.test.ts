import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAccessMock = vi.fn();
const listPropertiesMock = vi.fn();
const recordAuditEventMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireApiAccess: (...args: unknown[]) => requireApiAccessMock(...args),
  moduleUnavailableResponse: () =>
    Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } }),
}));
vi.mock("@/modules/real-estate/repository", () => ({
  listProperties: (...args: unknown[]) => listPropertiesMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));

const { GET } = await import("./route");

/**
 * Fictitious data only. What these tests pin down: the file stays behind the session,
 * the read is owner-scoped and bounded, the acquisition window has explicit boundaries,
 * the CSV guards apply to a name and a note, and the audit entry names this entity.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", role: "OWNER", modules: ["budget", "real-estate"] },
};

const PROPERTY = {
  id: "property-1",
  name: "Appartement Bastille",
  address: "12 rue de la Roquette, Paris",
  occupancy: "RENTED",
  purchaseDate: new Date(Date.UTC(2021, 4, 15)),
  saleDate: null,
  notes: null,
  cashflowCount: 3,
  foreignCurrencyCashflows: 1,
  income: new Decimal("1800.00"),
  expenses: new Decimal("-220.50"),
  net: new Decimal("1579.50"),
  currency: "EUR",
  priceCurrency: "EUR",
  purchasePrice: new Decimal("250000"),
  estimatedValue: new Decimal("280000"),
  estimatedValueAsOf: new Date(Date.UTC(2026, 8, 1)),
  targetGainRate: new Decimal("10"),
  salePrice: null,
  saleCosts: null,
};

const HEADER =
  "nom,adresse,occupation,date_acquisition,prix_acquisition,valeur_estimee,valeur_estimee_au,objectif_plus_value_pct,date_cession,prix_cession,frais_cession,devise,devise_prix,recettes,charges,solde,nombre_de_flux,flux_hors_devise_des_totaux,notes";

async function bodyOf(response: Response): Promise<string[]> {
  return (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
}

beforeEach(() => {
  requireApiAccessMock.mockReset().mockResolvedValue(OWNER);
  listPropertiesMock.mockReset().mockResolvedValue([PROPERTY]);
  recordAuditEventMock.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/export/properties", () => {
  it("refuses an unauthenticated request and reads nothing", async () => {
    requireApiAccessMock.mockResolvedValue(
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );

    const response = await GET(new Request("http://test.local/api/export/properties"));

    expect(response.status).toBe(401);
    expect(listPropertiesMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("answers 404 and reads nothing when the real-estate module is disabled", async () => {
    requireApiAccessMock.mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));

    const response = await GET(new Request("http://test.local/api/export/properties"));

    expect(response.status).toBe(404);
    expect(listPropertiesMock).not.toHaveBeenCalled();
  });

  it("exports every property, owner-scoped and bounded", async () => {
    const response = await GET(new Request("http://test.local/api/export/properties"));

    expect(response.status).toBe(200);
    expect(requireApiAccessMock).toHaveBeenCalledWith("export", "real-estate");
    expect(listPropertiesMock).toHaveBeenCalledWith(OWNER.workspace.id, {
      from: undefined,
      to: undefined,
      take: 10_001,
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="immobilier.csv"',
    );

    const lines = await bodyOf(response);
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(
      'Appartement Bastille,"12 rue de la Roquette, Paris",RENTED,2021-05-15,250000.00,280000.00,2026-09-01,10.00,,,,EUR,EUR,1800.00,-220.50,1579.50,3,1,',
    );
  });

  it("windows the acquisition date, both calendar days inclusive", async () => {
    const response = await GET(
      new Request("http://test.local/api/export/properties?from=2021-01-01&to=2021-12-31"),
    );

    expect(listPropertiesMock).toHaveBeenLastCalledWith(OWNER.workspace.id, {
      from: new Date(Date.UTC(2021, 0, 1)),
      to: new Date(Date.UTC(2022, 0, 1)),
      take: 10_001,
    });
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="immobilier-2021-01-01_2021-12-31.csv"',
    );
  });

  it("neutralises a formula typed in a name or a note", async () => {
    listPropertiesMock.mockResolvedValue([
      { ...PROPERTY, name: "=1+1", notes: "@SUM(A1:A9)" },
    ]);

    const body = await (await GET(new Request("http://test.local/api/export/properties"))).text();

    expect(body).toContain("'=1+1");
    expect(body).toContain("'@SUM(A1:A9)");
  });

  it("states that the file was cut when the read reached the row cap", async () => {
    listPropertiesMock.mockResolvedValue(
      Array.from({ length: 10_001 }, (_, index) => ({ ...PROPERTY, id: `property-${index}` })),
    );

    const response = await GET(new Request("http://test.local/api/export/properties"));

    expect(response.headers.get("X-Export-Truncated")).toBe("true");
    expect(await bodyOf(response)).toHaveLength(10_001);
  });

  it("records the export in the audit trail", async () => {
    await GET(new Request("http://test.local/api/export/properties"));

    expect(recordAuditEventMock).toHaveBeenCalledWith({
      workspaceId: OWNER.workspace.id,
      actorId: OWNER.id,
      action: "export.properties",
      entityType: "EXPORT",
      outcome: "SUCCESS",
      metadata: {
        entity: "properties",
        scope: "all",
        from: undefined,
        to: undefined,
        rows: 1,
        truncated: false,
      },
    });
  });
});
