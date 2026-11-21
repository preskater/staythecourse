import { EXPORT_TRUNCATED_HEADER } from "@/lib/csv";

/**
 * Markdown document helpers.
 *
 * The situation summary is the only Markdown export of the application. Like the CSV
 * writer in `lib/csv.ts` it delivers owner-supplied text, so it must not let a stored
 * value rewrite the document: a label containing a pipe would shift a table row, and a
 * line break would split a bullet or open a new heading. Both are neutralised here, in
 * one place, for the same reason the formula guard lives next to `toCsv`.
 */

/** Renders one cell: a pipe is escaped and every line break becomes a space. */
export function escapeMarkdownCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = value instanceof Date ? value.toISOString() : String(value);

  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

/** Renders free text used inline (a bullet, a paragraph), never inside a table. */
export function escapeMarkdownInline(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

/**
 * A GitHub-flavoured table, one line per row.
 *
 * Every cell goes through `escapeMarkdownCell`; a row with fewer cells than the header
 * is padded, so a missing value never shifts the next column.
 */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const line = (cells: readonly unknown[]): string =>
    `| ${headers.map((_, index) => escapeMarkdownCell(cells[index])).join(" | ")} |`;

  return [
    line(headers),
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

/**
 * Builds a downloadable Markdown response.
 *
 * `no-store` for the same reason as every export: the file carries personal financial
 * data and must never be cached by a shared proxy. There is no UTF-8 BOM here — it is
 * an Excel accommodation for CSV, and some Markdown readers render it as a stray glyph.
 */
export function createMarkdownResponse(
  markdown: string,
  fileName: string,
  options: { truncated?: boolean } = {},
): Response {
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      [EXPORT_TRUNCATED_HEADER]: options.truncated ? "true" : "false",
    },
  });
}
