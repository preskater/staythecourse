import Link from "next/link";

/**
 * The micro-business page's sub-sections.
 *
 * Each section is its own route, so the tab is a link: the URL stays shareable and only
 * the active section's queries run on the server. Same bar as the budget's.
 */
export const MICRO_BUSINESS_TABS = [
  { href: "/micro-business", label: "Clients et projets" },
  { href: "/micro-business/revenue", label: "Revenus" },
  { href: "/micro-business/rates", label: "Tarifs" },
] as const;

export type MicroBusinessTab = (typeof MICRO_BUSINESS_TABS)[number]["href"];

export function MicroBusinessTabs({ current }: { current: MicroBusinessTab }) {
  return (
    <nav aria-label="Sections de la micro-entreprise" className="flex flex-wrap gap-1">
      {MICRO_BUSINESS_TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? "page" : undefined}
          className={
            tab.href === current
              ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          }
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
