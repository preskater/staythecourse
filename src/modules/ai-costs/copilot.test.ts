import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPILOT_ACTIVITY_LABELS, COPILOT_SEAT_STATUS_LABELS, copilotSeatStatus } from "./copilot";

describe("copilotSeatStatus", () => {
  it("reconciles GitHub's breakdown with its own seat list, exactly", () => {
    expect(copilotSeatStatus({ total: 150, listedSeats: 150 })).toBe("RECONCILED");
    expect(copilotSeatStatus({ total: 150, listedSeats: 149 })).toBe("MISMATCH");
    expect(copilotSeatStatus({ total: 150, listedSeats: null })).toBe("INCOMPLETE");
  });
});

describe("Copilot wording", () => {
  // The only sentence allowed to name these words is the one denying them.
  const FORBIDDEN = /productiv|performan|efficac|classement|rang\b|meilleur|top /i;

  it("labels activity as activity, never as productivity", () => {
    for (const label of [...Object.values(COPILOT_ACTIVITY_LABELS), ...Object.values(COPILOT_SEAT_STATUS_LABELS)]) {
      expect(label).not.toMatch(FORBIDDEN);
    }
  });

  it("keeps the page itself free of productivity claims", () => {
    const source = readFileSync("src/app/(app)/ai-costs/copilot-section.tsx", "utf8");
    expect(source).not.toMatch(FORBIDDEN);
  });
});
