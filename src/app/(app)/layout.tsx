import Link from "next/link";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { MainNav, MobileNav, type NavLink } from "@/components/main-nav";
import { SearchForm } from "@/components/search-form";
import { UtilityNav } from "@/components/utility-nav";
import { requireUser } from "@/lib/auth/guard";
import { moduleNavLinks } from "@/modules/catalog/catalog";
import { hasPermission } from "@/modules/identity/permissions";
import { signOutAction } from "../login/actions";

/**
 * Layout for every private page.
 *
 * `requireUser()` re-checks the session on the server: the middleware redirect
 * alone is a convenience, not a security boundary. The navigation lists only the
 * modules active in the session's workspace; each module page checks it again.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const signOut = (
    <form action={signOutAction}>
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Se déconnecter
      </button>
    </form>
  );

  // The brand is the link home: listing "Tableau de bord" again in the links made the
  // header read as two competing entry points.
  //
  // The module row must not grow with the catalog: the entries every workspace has
  // (journal, module settings, account) live in their own `UtilityNav`.
  const moduleLinks: NavLink[] = [
    ...moduleNavLinks(user.workspace.modules),
    { href: "/alerts", label: "Alertes" },
  ];
  const utilityLinks: NavLink[] = [
    { href: "/audit", label: "Journal" },
    // Membership management is not a module: a household shares the workspace it
    // already has. Only the roles that can manage it see the entry.
    ...(hasPermission(user.workspace.role, "manage-members")
      ? [{ href: "/members", label: "Membres" }]
      : []),
    { href: "/modules", label: "Modules" },
    { href: "/account", label: "Compte" },
  ];

  const accountControls = (
    <>
      <span className="max-w-44 truncate text-xs text-zinc-500 dark:text-zinc-400">
        {user.email}
      </span>
      {signOut}
    </>
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="relative border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto w-full max-w-6xl px-4 pt-3 pb-2">
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/dashboard" className="font-semibold tracking-tight">
              Tableau de bord
            </Link>

            {/* The one search entry point. Full width under the title on phones, inline
                from `sm` up, so it never competes with the navigation for one row. */}
            <SearchForm
              id="header-search"
              shortcut
              className="order-last w-full sm:order-none sm:ml-auto sm:w-72"
            />

            <div className="hidden items-center gap-3 lg:flex">{accountControls}</div>

            <MobileNav links={moduleLinks}>
              {/* Small screens: the utility links and the account controls live in the
                  burger menu, below the module links. */}
              <UtilityNav
                links={utilityLinks}
                className="flex flex-col gap-1 border-t border-zinc-200 pt-3 dark:border-zinc-800"
              />
              <div className="flex items-center justify-between gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {user.email}
                </span>
                {signOut}
              </div>
            </MobileNav>
          </div>

          {/* Primary navigation on the left, always-present entries on the right: one
              row that stays short as modules are added. */}
          <div className="mt-1 hidden items-center justify-between gap-2 lg:flex">
            <MainNav links={moduleLinks} />
            <UtilityNav
              links={utilityLinks}
              className="flex flex-wrap items-center gap-1 border-l border-zinc-200 pl-2 dark:border-zinc-800"
            />
          </div>
        </div>
      </header>

      <KeyboardShortcuts />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
