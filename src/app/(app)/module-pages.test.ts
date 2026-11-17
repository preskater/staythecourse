import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleDisabled } from "@/components/module-disabled";
import type { ModuleKey } from "@/modules/catalog/catalog";

const requireUserMock = vi.fn();
const readMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({ requireUser: () => requireUserMock() }));
// Any read of a module's data fails the test: a disabled module must render without one.
vi.mock("@/lib/db", () => ({ getPrisma: () => readMock() }));

/** Fictitious owner; only the workspace's modules change between cases. */
function sessionWith(modules: ModuleKey[], role = "OWNER") {
  return {
    id: "owner-1",
    email: "owner@example.test",
    name: null,
    workspace: { id: "ws-owner-1", name: "Personnel", kind: "PERSONAL", role, modules },
  };
}

const PAGES: { path: string; moduleKey: ModuleKey; load: () => Promise<{ default: (props: never) => unknown }> }[] = [
  { path: "/budget", moduleKey: "budget", load: () => import("./budget/page") },
  { path: "/budget/import", moduleKey: "budget", load: () => import("./budget/import/page") },
  { path: "/real-estate", moduleKey: "real-estate", load: () => import("./real-estate/page") },
  { path: "/real-estate/calendar", moduleKey: "real-estate", load: () => import("./real-estate/calendar/page") },
  { path: "/real-estate/[id]", moduleKey: "real-estate", load: () => import("./real-estate/[id]/page") },
  { path: "/micro-business", moduleKey: "micro-business", load: () => import("./micro-business/page") },
  { path: "/integrations", moduleKey: "development", load: () => import("./integrations/page") },
];

const props = {
  searchParams: Promise.resolve({}),
  params: Promise.resolve({ id: "property-1" }),
} as never;

describe("direct access to a disabled module", () => {
  beforeEach(() => {
    readMock.mockReset().mockImplementation(() => {
      throw new Error("a disabled module's data was read");
    });
  });

  it.each(PAGES)(
    "$path renders the disabled state and reads nothing",
    async ({ moduleKey, load }) => {
      // Every other module stays active: only the page's own module decides.
      requireUserMock.mockResolvedValue(
        sessionWith((["budget", "real-estate", "development"] as const).filter((key) => key !== moduleKey)),
      );
      const { default: Page } = await load();

      const element = (await Page(props)) as { type: unknown; props: { moduleKey: ModuleKey } };

      expect(element.type).toBe(ModuleDisabled);
      expect(element.props.moduleKey).toBe(moduleKey);
      expect(readMock).not.toHaveBeenCalled();
    },
    // The first dynamic import compiles the page's whole graph: on a cold or slow
    // filesystem that can exceed Vitest's 5 s default.
    20_000,
  );
});

describe("ModuleDisabled", () => {
  const render = (role: string) =>
    renderToStaticMarkup(
      createElement(ModuleDisabled, {
        moduleKey: "budget",
        workspace: { name: "Personnel", role: role as "OWNER" },
      }),
    );

  it("explains the state and offers the settings to a manager", () => {
    const html = render("ADMIN");
    expect(html).toContain("Le module « Budget » n&#x27;est pas actif");
    expect(html).toContain("Ses données sont conservées");
    expect(html).toContain('href="/modules"');
  });

  it("tells a member who can re-enable it, without a settings link", () => {
    const html = render("MEMBER");
    expect(html).not.toContain('href="/modules"');
    expect(html).toContain("administrateurs");
  });
});
