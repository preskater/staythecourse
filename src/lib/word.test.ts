import { describe, expect, it } from "vitest";
import { plural } from "./word";

describe("plural", () => {
  it("keeps the singular for 0 and 1, as in French", () => {
    expect(plural(0, "ligne")).toBe("0 ligne");
    expect(plural(1, "ligne")).toBe("1 ligne");
  });

  it("adds an s above 1, or uses the irregular form", () => {
    expect(plural(2, "ligne")).toBe("2 lignes");
    expect(plural(3, "travail", "travaux")).toBe("3 travaux");
  });
});
