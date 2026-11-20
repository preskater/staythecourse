import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidInvoiceError } from "@/modules/ai-costs/invoice.repository";

const requireModuleMock = vi.fn();
const auditMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireModule: (...args: unknown[]) => requireModuleMock(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/modules/audit/repository", () => ({ recordAuditEventSafely: (...args: unknown[]) => auditMock(...args) }));
vi.mock("@/modules/ai-costs/invoice.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai-costs/invoice.repository")>()),
  createProviderInvoice: (...args: unknown[]) => createMock(...args),
  deleteProviderInvoice: (...args: unknown[]) => deleteMock(...args),
}));

const { createInvoiceAction, deleteInvoiceAction } = await import("./actions");

const sessionAs = (role: string) => ({ id: "user-1", workspace: { id: "ws-1", role, modules: ["ai-costs"] } });

const invoice = {
  provider: "OPENAI",
  number: "INV-001",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  issuedOn: "2026-11-02",
  currency: "USD",
  total: "100,00",
  exchangeRateSnapshotId: "",
  notes: "",
  lines: [{ label: "Usage API", amount: "100,00", category: "USAGE" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
  createMock.mockResolvedValue({ id: "invoice-1" });
  deleteMock.mockResolvedValue(true);
});

describe("createInvoiceAction", () => {
  it("writes into the session's workspace and audits ids and counts only", async () => {
    expect(await createInvoiceAction(invoice)).toEqual({ status: "ok" });
    expect(createMock).toHaveBeenCalledWith("ws-1", expect.objectContaining({ number: "INV-001", currency: "USD" }));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        actorId: "user-1",
        action: "cost.invoice_create",
        entityId: "invoice-1",
        metadata: { provider: "OPENAI", lines: 1 },
      }),
    );
  });

  it.each(["VIEWER", "MEMBER"])("refuses a %s before reading anything", async (role) => {
    requireModuleMock.mockResolvedValue(sessionAs(role));
    expect(await createInvoiceAction(invoice)).toMatchObject({ status: "error" });
    expect(createMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("reports a foreign rate and a duplicate number on their fields", async () => {
    createMock.mockRejectedValueOnce(new InvalidInvoiceError("exchangeRateSnapshotId", "Taux introuvable dans cet espace."));
    expect(await createInvoiceAction(invoice)).toMatchObject({
      status: "invalid",
      fieldErrors: { exchangeRateSnapshotId: ["Taux introuvable dans cet espace."] },
    });
    createMock.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await createInvoiceAction(invoice)).toMatchObject({ status: "invalid", fieldErrors: { number: expect.any(Array) } });
  });

  it("validates again on the server", async () => {
    expect(await createInvoiceAction({ ...invoice, lines: [] })).toMatchObject({ status: "invalid" });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("deleteInvoiceAction", () => {
  it("deletes inside the workspace and reports a foreign id as not found", async () => {
    expect(await deleteInvoiceAction({ id: "invoice-1" })).toEqual({ status: "ok" });
    expect(deleteMock).toHaveBeenCalledWith("ws-1", "invoice-1");

    deleteMock.mockResolvedValueOnce(false);
    expect(await deleteInvoiceAction({ id: "foreign" })).toMatchObject({ status: "error" });
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a viewer", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("VIEWER"));
    expect(await deleteInvoiceAction({ id: "invoice-1" })).toMatchObject({ status: "error" });
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
