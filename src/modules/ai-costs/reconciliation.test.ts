import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { reconcileTotals } from "./reconciliation";

const totals = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([currency, amount]) => [currency, new Decimal(amount)]));

describe("reconcileTotals", () => {
  it("reconciles float drift well under a cent", () => {
    const result = reconcileTotals({
      imported: totals({ USD: "0.30000000000000004" }),
      provider: totals({ USD: "0.3" }),
      complete: true,
    });
    expect(result.status).toBe("RECONCILED");
    expect(result.currencies[0]).toMatchObject({ difference: "0.00000000000000004" });
  });

  it("accepts a gap of exactly the tolerance", () => {
    const result = reconcileTotals({
      imported: totals({ USD: "10.00" }),
      provider: totals({ USD: "10.01" }),
      complete: true,
    });
    expect(result.status).toBe("RECONCILED");
  });

  it("flags a gap above the tolerance as a mismatch", () => {
    const result = reconcileTotals({
      imported: totals({ USD: "10.00" }),
      provider: totals({ USD: "10.02" }),
      complete: true,
    });
    expect(result.status).toBe("MISMATCH");
    expect(result.currencies[0]).toMatchObject({ difference: "-0.02", withinTolerance: false });
  });

  it("compares a currency missing on one side against zero", () => {
    const result = reconcileTotals({
      imported: totals({ USD: "5" }),
      provider: totals({ USD: "5", EUR: "3" }),
      complete: true,
    });
    expect(result.status).toBe("MISMATCH");
    expect(result.currencies.find((row) => row.currency === "EUR")).toMatchObject({
      imported: "0",
      provider: "3",
    });
  });

  it("handles credits: a negative total reconciles like any other", () => {
    const result = reconcileTotals({
      imported: totals({ USD: "-1.50" }),
      provider: totals({ USD: "-1.5" }),
      complete: true,
    });
    expect(result.status).toBe("RECONCILED");
  });

  it("reconciles an empty window as zero against zero", () => {
    expect(reconcileTotals({ imported: new Map(), provider: new Map(), complete: true })).toEqual({
      status: "RECONCILED",
      currencies: [],
    });
  });

  it("never claims a reconciliation when a side was not fully read", () => {
    const result = reconcileTotals({
      imported: totals({ USD: "1" }),
      provider: totals({ USD: "1" }),
      complete: false,
    });
    expect(result.status).toBe("INCOMPLETE");
  });
});
