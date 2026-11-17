import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/dates";
import type { RevenueDocumentRecord } from "@/modules/micro-business/revenue";

const requireModuleMock = vi.fn();
const revalidatePathMock = vi.fn();
const recordAuditEventSafelyMock = vi.fn();
const createRevenueDocumentMock = vi.fn();
const createRevenueMovementMock = vi.fn();
const findProjectMock = vi.fn();
const findRevenueDocumentMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireModule: (...args: unknown[]) => requireModuleMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));
vi.mock("@/modules/audit/repository", () => ({
  recordAuditEventSafely: (...args: unknown[]) => recordAuditEventSafelyMock(...args),
}));
vi.mock("@/modules/micro-business/repository", () => ({
  createRevenueDocument: (...args: unknown[]) => createRevenueDocumentMock(...args),
  createRevenueMovement: (...args: unknown[]) => createRevenueMovementMock(...args),
  findProject: (...args: unknown[]) => findProjectMock(...args),
  findRevenueDocument: (...args: unknown[]) => findRevenueDocumentMock(...args),
}));

const { createRevenueDocumentAction, recordRevenueMovementAction } = await import(
  "./revenue-actions"
);

/** Fictitious session; the workspace always comes from it, never from the request. */
function sessionAs(role: string) {
  return {
    id: "user-1",
    email: "owner@example.test",
    name: null,
    sessionId: "session-1",
    workspace: {
      id: "ws-user-1",
      name: "Entreprise",
      kind: "COMPANY",
      role,
      modules: ["micro-business"],
    },
  };
}

const project = {
  id: "project-1",
  name: "Refonte",
  clientId: "client-1",
  clientName: "Studio Lumen",
  billingModel: "FIXED_PRICE",
  status: "ACTIVE",
  currency: "EUR",
  startDate: null,
  endDate: null,
  notes: null,
  archived: false,
};

function invoice(overrides: Partial<RevenueDocumentRecord> = {}): RevenueDocumentRecord {
  return {
    id: "invoice-1",
    kind: "INVOICE",
    projectId: "project-1",
    projectName: "Refonte",
    clientId: "client-1",
    clientName: "Studio Lumen",
    currency: "EUR",
    amount: new Decimal("1000.00"),
    issuedOn: parseDateOnly("2026-01-01"),
    dueOn: parseDateOnly("2099-12-31"),
    recognizedOn: null,
    recognizedAmount: null,
    notes: null,
    creditNoteFor: null,
    creditedBy: [],
    payments: [],
    refunds: [],
    writeOffs: [],
    ...overrides,
  };
}

const invoicePayload = {
  kind: "INVOICE",
  projectId: "project-1",
  creditNoteForId: "",
  amount: "1 000,00",
  issuedOn: "2026-01-10",
  dueOn: "2099-12-31",
  recognizedOn: "",
  recognizedAmount: "",
  notes: "",
};

const creditNotePayload = {
  ...invoicePayload,
  kind: "CREDIT_NOTE",
  projectId: "",
  creditNoteForId: "invoice-1",
  dueOn: "",
  issuedOn: "2026-02-01",
};

const paymentPayload = {
  type: "PAYMENT",
  documentId: "invoice-1",
  amount: "1 000,00",
  date: "2099-01-01",
  notes: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleMock.mockResolvedValue(sessionAs("OWNER"));
  createRevenueDocumentMock.mockResolvedValue({ id: "document-1" });
  createRevenueMovementMock.mockResolvedValue({ id: "movement-1" });
  findProjectMock.mockResolvedValue(project);
  findRevenueDocumentMock.mockResolvedValue(invoice());
});

describe("createRevenueDocumentAction", () => {
  it("creates an invoice in the project's currency and snapshots its client", async () => {
    const result = await createRevenueDocumentAction(invoicePayload);

    expect(result.status).toBe("ok");
    expect(createRevenueDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-user-1",
        projectId: "project-1",
        clientId: "client-1",
        kind: "INVOICE",
        currency: "EUR",
        creditNoteForId: null,
      }),
    );
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revenue.invoice", outcome: "SUCCESS" }),
    );
  });

  it("refuses a non-billable project instead of inventing revenue", async () => {
    findProjectMock.mockResolvedValue({ ...project, billingModel: "INTERNAL", clientId: null });

    const result = await createRevenueDocumentAction(invoicePayload);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("pas facturable");
    expect(createRevenueDocumentMock).not.toHaveBeenCalled();
  });

  it("refuses an archived project", async () => {
    findProjectMock.mockResolvedValue({ ...project, archived: true });

    const result = await createRevenueDocumentAction(invoicePayload);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("archivé");
    expect(createRevenueDocumentMock).not.toHaveBeenCalled();
  });

  it("refuses a member who may read but not write", async () => {
    requireModuleMock.mockResolvedValue(sessionAs("MEMBER"));

    const result = await createRevenueDocumentAction(invoicePayload);

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toContain("propriétaire");
    expect(findProjectMock).not.toHaveBeenCalled();
    expect(createRevenueDocumentMock).not.toHaveBeenCalled();
  });

  it("refuses a credit note above the invoice's remaining balance", async () => {
    const result = await createRevenueDocumentAction({
      ...creditNotePayload,
      amount: "1 000,01",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("dépasse le reste dû");
    expect(createRevenueDocumentMock).not.toHaveBeenCalled();
  });

  it("creates a credit note at the invoice's balance", async () => {
    const result = await createRevenueDocumentAction(creditNotePayload);

    expect(result.status).toBe("ok");
    expect(createRevenueDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CREDIT_NOTE",
        creditNoteForId: "invoice-1",
        projectId: "project-1",
        clientId: "client-1",
        currency: "EUR",
        dueOn: null,
      }),
    );
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revenue.credit_note" }),
    );
  });
});

describe("recordRevenueMovementAction", () => {
  it("records a payment up to the outstanding balance", async () => {
    const result = await recordRevenueMovementAction(paymentPayload);

    expect(result.status).toBe("ok");
    expect(createRevenueMovementMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PAYMENT", documentId: "invoice-1" }),
    );
    expect(recordAuditEventSafelyMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revenue.payment" }),
    );
  });

  it("refuses an overpayment and writes nothing", async () => {
    const result = await recordRevenueMovementAction({
      ...paymentPayload,
      amount: "1 000,01",
    });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("trop-perçu");
    expect(createRevenueMovementMock).not.toHaveBeenCalled();
    expect(recordAuditEventSafelyMock).not.toHaveBeenCalled();
  });

  it("refuses a movement aimed at a credit note", async () => {
    findRevenueDocumentMock.mockResolvedValue(invoice({ kind: "CREDIT_NOTE" }));

    const result = await recordRevenueMovementAction(paymentPayload);

    expect(result.status).toBe("invalid");
    expect(createRevenueMovementMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown invoice without revealing anything", async () => {
    findRevenueDocumentMock.mockResolvedValue(null);

    const result = await recordRevenueMovementAction(paymentPayload);

    expect(result.status).toBe("invalid");
    expect(createRevenueMovementMock).not.toHaveBeenCalled();
  });
});
