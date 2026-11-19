import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionMenu } from "./action-menu";

/**
 * A download item must leave the App Router alone: a client navigation to an export
 * Route Handler keeps the export URL as the current route while the browser stays on
 * the page, and the next Server Action is posted there (405). The plain `<a download>`
 * is what prevents that, so it is asserted on the rendered markup.
 */
describe("ActionMenu", () => {
  const render = () =>
    renderToStaticMarkup(
      createElement(ActionMenu, {
        label: "Actions",
        groups: [
          {
            label: "Exporter",
            items: [
              { href: "/api/export/summary", label: "Synthèse", download: true },
              { href: "/budget/import", label: "Importer" },
            ],
          },
        ],
      }),
    );

  it("renders a download item as an anchor carrying the download attribute", () => {
    const html = render();

    expect(html).toMatch(/<a[^>]*href="\/api\/export\/summary"[^>]*download/);
  });

  it("leaves a navigation item without the download attribute", () => {
    const html = render();

    expect(html).toMatch(/<a[^>]*href="\/budget\/import"[^>]*>/);
    const navigationTag = html.match(/<a[^>]*href="\/budget\/import"[^>]*>/)?.[0] ?? "";
    expect(navigationTag).not.toContain("download");
  });
});
