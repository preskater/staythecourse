import { describe, expect, it } from "vitest";
import { createMarkdownResponse, escapeMarkdownCell, markdownTable } from "./markdown";
import { EXPORT_TRUNCATED_HEADER } from "./csv";

/** Fictitious values only: the guards are what these tests pin down. */
describe("escapeMarkdownCell", () => {
  it("escapes a pipe so a label cannot shift a table row", () => {
    expect(escapeMarkdownCell("Loyer | charges")).toBe("Loyer \\| charges");
  });

  it("collapses line breaks so a value cannot open a new block", () => {
    expect(escapeMarkdownCell("Ligne\n## Titre")).toBe("Ligne ## Titre");
    expect(escapeMarkdownCell("Ligne\r\nsuite")).toBe("Ligne suite");
  });

  it("renders null and undefined as an empty cell, never as text", () => {
    expect(escapeMarkdownCell(null)).toBe("");
    expect(escapeMarkdownCell(undefined)).toBe("");
  });

  it("keeps a signed amount readable", () => {
    expect(escapeMarkdownCell("-45.90")).toBe("-45.90");
  });
});

describe("markdownTable", () => {
  it("builds a header, a separator and one line per row", () => {
    const table = markdownTable(["Compte", "Solde"], [["Courant", "10.00"]]);

    expect(table.split("\n")).toEqual([
      "| Compte | Solde |",
      "| --- | --- |",
      "| Courant | 10.00 |",
    ]);
  });

  it("escapes the cells and pads a short row instead of shifting columns", () => {
    const [, , row] = markdownTable(["A", "B", "C"], [["x|y"]]).split("\n");

    expect(row).toBe("| x\\|y |  |  |");
  });
});

describe("createMarkdownResponse", () => {
  it("downloads the file with no-store and the truncation header", async () => {
    const response = createMarkdownResponse("# Synthèse", "synthese-2026-11.md", {
      truncated: true,
    });

    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="synthese-2026-11.md"',
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get(EXPORT_TRUNCATED_HEADER)).toBe("true");
    expect(await response.text()).toBe("# Synthèse");
  });

  it("states an uncut file explicitly", () => {
    const response = createMarkdownResponse("x", "x.md");

    expect(response.headers.get(EXPORT_TRUNCATED_HEADER)).toBe("false");
  });
});
