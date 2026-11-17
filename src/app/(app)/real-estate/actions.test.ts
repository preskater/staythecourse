import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const findPropertyMock = vi.fn();
const findLoanMock = vi.fn();
const createLoanMock = vi.fn();
const updateLoanMock = vi.fn();
const deleteLoanMock = vi.fn();
const updatePropertyMock = vi.fn();
const deletePropertyMock = vi.fn();
const getPropertyDetailMock = vi.fn();
const savePropertySaleMock = vi.fn();
const findPropertyEventMock = vi.fn();
const createPropertyEventMock = vi.fn();
const updatePropertyEventMock = vi.fn();
const deletePropertyEventMock = vi.fn();
const createTransactionMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireModule: (key: string) => requireUserMock(key) }));
vi.mock("@/modules/real-estate/repository", () => ({
  createProperty: vi.fn(),
  createCashflow: vi.fn(),
  findProperty: (...args: unknown[]) => findPropertyMock(...args),
  findLoan: (...args: unknown[]) => findLoanMock(...args),
  createLoan: (...args: unknown[]) => createLoanMock(...args),
  updateLoan: (...args: unknown[]) => updateLoanMock(...args),
  deleteLoan: (...args: unknown[]) => deleteLoanMock(...args),
  updateProperty: (...args: unknown[]) => updatePropertyMock(...args),
  deleteProperty: (...args: unknown[]) => deletePropertyMock(...args),
  getPropertyDetail: (...args: unknown[]) => getPropertyDetailMock(...args),
  savePropertySale: (...args: unknown[]) => savePropertySaleMock(...args),
  findPropertyEvent: (...args: unknown[]) => findPropertyEventMock(...args),
  createPropertyEvent: (...args: unknown[]) => createPropertyEventMock(...args),
  updatePropertyEvent: (...args: unknown[]) => updatePropertyEventMock(...args),
  deletePropertyEvent: (...args: unknown[]) => deletePropertyEventMock(...args),
}));
vi.mock("@/modules/budget/repository", () => ({
  findTransactionRef: vi.fn(),
  createTransaction: (...args: unknown[]) => createTransactionMock(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const {
  createLoanAction,
  updateLoanAction,
  deleteLoanAction,
  updatePropertyAction,
  deletePropertyAction,
  sellPropertyAction,
  createPropertyEventAction,
  updatePropertyEventAction,
  deletePropertyEventAction,
} = await import("./actions");

/**
 * Fictitious data only. Authorisation and ownership are decided in the action, so it
 * is exercised against mocked repositories: no test touches a database.
 */
const OWNER = {
  id: "owner-1",
  email: "owner@example.test",
  name: null,
  workspace: { id: "ws-owner-1", modules: ["budget", "real-estate", "development"] },
};

const validLoan = {
  propertyId: "property-1",
  label: "Crédit immobilier",
  currency: "EUR",
  initialPrincipal: "250000,00",
  outstandingBalance: "198500,00",
  balanceAsOf: "2026-01-01",
  interestRate: "3,45",
  termMonths: "240",
  paymentAmount: "1250,00",
  insuranceAmount: "45,00",
  startDate: "2021-06-01",
  endDate: "2041-06-01",
  notes: "",
};

describe("createLoanAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findPropertyMock.mockReset().mockResolvedValue({ id: "property-1", name: "Bien" });
    createLoanMock.mockReset().mockResolvedValue({ id: "loan-1" });
    revalidatePathMock.mockReset();
  });

  it("writes a loan for the owner's property", async () => {
    const result = await createLoanAction(validLoan);

    expect(result.status).toBe("ok");
    expect(findPropertyMock).toHaveBeenCalledWith("ws-owner-1", "property-1");
    expect(createLoanMock).toHaveBeenCalledTimes(1);
    const input = createLoanMock.mock.calls[0][0] as { initialPrincipal: Decimal };
    expect(input.initialPrincipal.toFixed(2)).toBe("250000.00");
    expect(revalidatePathMock).toHaveBeenCalledWith("/real-estate");
  });

  it("refuses a foreign or unknown property and writes nothing", async () => {
    findPropertyMock.mockResolvedValue(null);

    const result = await createLoanAction(validLoan);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
    expect(createLoanMock).not.toHaveBeenCalled();
  });

  it("refuses an invalid payload before any lookup", async () => {
    const result = await createLoanAction({ ...validLoan, initialPrincipal: "-5" });

    expect(result.status).toBe("invalid");
    expect(findPropertyMock).not.toHaveBeenCalled();
    expect(createLoanMock).not.toHaveBeenCalled();
  });
});

describe("updateLoanAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findPropertyMock.mockReset().mockResolvedValue({ id: "property-1", name: "Bien" });
    findLoanMock.mockReset().mockResolvedValue({ id: "loan-1" });
    updateLoanMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("updates an owner-scoped loan", async () => {
    const result = await updateLoanAction({ ...validLoan, id: "loan-1" });

    expect(result.status).toBe("ok");
    expect(updateLoanMock).toHaveBeenCalledTimes(1);
    expect(updateLoanMock.mock.calls[0][0]).toBe("ws-owner-1");
    expect(updateLoanMock.mock.calls[0][1]).toBe("loan-1");
  });

  it("refuses an unknown loan and does not update", async () => {
    findLoanMock.mockResolvedValue(null);

    const result = await updateLoanAction({ ...validLoan, id: "foreign" });

    expect(result.status).toBe("invalid");
    expect(updateLoanMock).not.toHaveBeenCalled();
  });
});

describe("deleteLoanAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    deleteLoanMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("deletes an owner-scoped loan", async () => {
    const result = await deleteLoanAction({ id: "loan-1" });

    expect(result.status).toBe("ok");
    expect(deleteLoanMock).toHaveBeenCalledWith("ws-owner-1", "loan-1");
  });

  it("refuses an unknown loan and reports it", async () => {
    deleteLoanMock.mockResolvedValue(false);

    const result = await deleteLoanAction({ id: "loan-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
  });
});

/** Values as the property edit form sends them: everything is a string. */
const validProperty = {
  name: "Appartement de test",
  address: "",
  occupancy: "VACANT",
  currency: "EUR",
  purchaseDate: "2021-06-15",
  purchasePrice: "200000,00",
  estimatedValue: "250000,00",
  estimatedValueAsOf: "2026-10-01",
  targetGainRate: "10",
  notes: "",
};

describe("updatePropertyAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findPropertyMock.mockReset().mockResolvedValue({ id: "property-1", name: "Bien" });
    updatePropertyMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("updates an owner-scoped property with exact amounts", async () => {
    const result = await updatePropertyAction({ ...validProperty, id: "property-1" });

    expect(result.status).toBe("ok");
    expect(updatePropertyMock).toHaveBeenCalledTimes(1);
    expect(updatePropertyMock.mock.calls[0][0]).toBe("ws-owner-1");
    expect(updatePropertyMock.mock.calls[0][1]).toBe("property-1");
    const input = updatePropertyMock.mock.calls[0][2] as { purchasePrice: Decimal };
    expect(input.purchasePrice.toFixed(2)).toBe("200000.00");
    expect(revalidatePathMock).toHaveBeenCalledWith("/real-estate/property-1");
  });

  it("refuses a foreign or unknown property and writes nothing", async () => {
    findPropertyMock.mockResolvedValue(null);

    const result = await updatePropertyAction({ ...validProperty, id: "foreign" });

    expect(result.status).toBe("invalid");
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });

  it("refuses an invalid payload before any lookup", async () => {
    const result = await updatePropertyAction({
      ...validProperty,
      id: "property-1",
      purchasePrice: "-1",
    });

    expect(result.status).toBe("invalid");
    expect(findPropertyMock).not.toHaveBeenCalled();
  });
});

describe("deletePropertyAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    deletePropertyMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("deletes an owner-scoped property and says what disappears with it", async () => {
    const result = await deletePropertyAction({ id: "property-1" });

    expect(result.status).toBe("ok");
    expect(deletePropertyMock).toHaveBeenCalledWith("ws-owner-1", "property-1");
    expect(result.status === "ok" && result.message).toMatch(/flux/i);
  });

  it("refuses an unknown property", async () => {
    deletePropertyMock.mockResolvedValue(false);

    const result = await deletePropertyAction({ id: "property-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
  });
});

const sale = {
  id: "property-1",
  saleDate: "2026-10-21",
  salePrice: "300000,00",
  saleCosts: "15000,00",
};

function propertyDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "property-1",
    name: "Appartement",
    purchaseDate: new Date(Date.UTC(2021, 5, 15)),
    saleDate: null,
    priceCurrency: "EUR",
    analysis: {
      netInvested: new Decimal("203000.00"),
      outstandingDebt: new Decimal("50000.00"),
      unknownLoanBalances: 0,
      foreignCurrencyLoans: 0,
      currencyMismatch: false,
    },
    ...overrides,
  };
}

describe("sellPropertyAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    getPropertyDetailMock.mockReset().mockResolvedValue(propertyDetail());
    savePropertySaleMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("records the sale and reports the net gain computed server-side", async () => {
    const result = await sellPropertyAction(sale);

    expect(result.status).toBe("ok");
    expect(savePropertySaleMock).toHaveBeenCalledTimes(1);
    const input = savePropertySaleMock.mock.calls[0][2] as {
      salePrice: Decimal;
      saleCosts: Decimal;
    };
    expect(input.salePrice.toFixed(2)).toBe("300000.00");
    // 300 000 − 15 000 costs − 50 000 debt − 203 000 invested = 32 000.
    expect(result.status === "ok" && result.message).toMatch(/Gain net/);
    expect(result.status === "ok" && result.message).toMatch(/32/);
  });

  it("refuses a sale dated before the acquisition", async () => {
    const result = await sellPropertyAction({ ...sale, saleDate: "2020-01-01" });

    expect(result.status).toBe("invalid");
    expect(savePropertySaleMock).not.toHaveBeenCalled();
  });

  it("still records the sale when the gain cannot be computed", async () => {
    getPropertyDetailMock.mockResolvedValue(
      propertyDetail({
        analysis: {
          netInvested: null,
          outstandingDebt: new Decimal("0"),
          unknownLoanBalances: 0,
          foreignCurrencyLoans: 0,
          currencyMismatch: false,
        },
      }),
    );

    const result = await sellPropertyAction(sale);

    expect(result.status).toBe("ok");
    expect(savePropertySaleMock).toHaveBeenCalledTimes(1);
    expect(result.status === "ok" && result.message).toMatch(/Gain inconnu/);
  });

  it("refuses an unknown property", async () => {
    getPropertyDetailMock.mockResolvedValue(null);

    const result = await sellPropertyAction(sale);

    expect(result.status).toBe("invalid");
    expect(savePropertySaleMock).not.toHaveBeenCalled();
  });
});

/** Values as the event form sends them: everything is a string. */
const validEvent = {
  propertyId: "property-1",
  kind: "TAX",
  label: "Taxe foncière 2027",
  dueDate: "2027-10-15",
  status: "PLANNED",
  amount: "1200,00",
  currency: "EUR",
  notes: "",
};

describe("createPropertyEventAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findPropertyMock.mockReset().mockResolvedValue({ id: "property-1", name: "Bien" });
    createPropertyEventMock.mockReset().mockResolvedValue({ id: "event-1" });
    createTransactionMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("writes an event for the owner's property and no transaction", async () => {
    const result = await createPropertyEventAction(validEvent);

    expect(result.status).toBe("ok");
    expect(findPropertyMock).toHaveBeenCalledWith("ws-owner-1", "property-1");
    expect(createPropertyEventMock).toHaveBeenCalledTimes(1);
    const input = createPropertyEventMock.mock.calls[0][1] as { amount: Decimal };
    expect(input.amount.toFixed(2)).toBe("1200.00");
    // An obligation is a reminder: it can never create a payment row.
    expect(createTransactionMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/real-estate");
    expect(revalidatePathMock).toHaveBeenCalledWith("/real-estate/property-1");
  });

  it("accepts an undated event", async () => {
    const result = await createPropertyEventAction({ ...validEvent, dueDate: "" });

    expect(result.status).toBe("ok");
    expect(createPropertyEventMock).toHaveBeenCalledTimes(1);
    expect((createPropertyEventMock.mock.calls[0][1] as { dueDate: Date | null }).dueDate).toBeNull();
  });

  it("refuses a foreign or unknown property and writes nothing", async () => {
    findPropertyMock.mockResolvedValue(null);

    const result = await createPropertyEventAction(validEvent);

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
    expect(createPropertyEventMock).not.toHaveBeenCalled();
  });

  it("refuses an invalid payload before any lookup", async () => {
    const result = await createPropertyEventAction({ ...validEvent, amount: "-5" });

    expect(result.status).toBe("invalid");
    expect(findPropertyMock).not.toHaveBeenCalled();
    expect(createPropertyEventMock).not.toHaveBeenCalled();
  });
});

describe("updatePropertyEventAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findPropertyEventMock.mockReset().mockResolvedValue({
      id: "event-1",
      propertyId: "property-1",
    });
    findPropertyMock.mockReset().mockResolvedValue({ id: "property-1", name: "Bien" });
    updatePropertyEventMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("updates an owner-scoped event", async () => {
    const result = await updatePropertyEventAction({ ...validEvent, id: "event-1" });

    expect(result.status).toBe("ok");
    expect(updatePropertyEventMock).toHaveBeenCalledTimes(1);
    expect(updatePropertyEventMock.mock.calls[0][0]).toBe("ws-owner-1");
    expect(updatePropertyEventMock.mock.calls[0][1]).toBe("event-1");
  });

  it("refuses an unknown event and does not update", async () => {
    findPropertyEventMock.mockResolvedValue(null);

    const result = await updatePropertyEventAction({ ...validEvent, id: "foreign" });

    expect(result.status).toBe("invalid");
    expect(updatePropertyEventMock).not.toHaveBeenCalled();
  });

  it("refuses moving an event to a foreign property", async () => {
    findPropertyMock.mockResolvedValue(null);

    const result = await updatePropertyEventAction({
      ...validEvent,
      id: "event-1",
      propertyId: "property-foreign",
    });

    expect(result.status).toBe("invalid");
    expect(updatePropertyEventMock).not.toHaveBeenCalled();
  });
});

describe("deletePropertyEventAction", () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockResolvedValue(OWNER);
    findPropertyEventMock.mockReset().mockResolvedValue({
      id: "event-1",
      propertyId: "property-1",
    });
    deletePropertyEventMock.mockReset().mockResolvedValue(true);
    revalidatePathMock.mockReset();
  });

  it("deletes an owner-scoped event and refreshes its property", async () => {
    const result = await deletePropertyEventAction({ id: "event-1" });

    expect(result.status).toBe("ok");
    expect(deletePropertyEventMock).toHaveBeenCalledWith("ws-owner-1", "event-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/real-estate/property-1");
  });

  it("refuses an unknown event and reports it", async () => {
    findPropertyEventMock.mockResolvedValue(null);

    const result = await deletePropertyEventAction({ id: "event-1" });

    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/introuvable/i);
    expect(deletePropertyEventMock).not.toHaveBeenCalled();
  });
});
