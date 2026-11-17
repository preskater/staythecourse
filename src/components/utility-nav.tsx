"use client";

import { usePathname } from "next/navigation";
import { NavLinkItem, type NavLink } from "./main-nav";

/**
 * Utility navigation: the entries every workspace has, whatever its modules.
 *
 * Keeping « Journal », « Modules » and « Compte » out of the module row is what keeps
 * that row short as the catalog grows. They are rendered as a second, visually
 * separated group on desktop and stacked in the burger on small screens.
 */
export function UtilityNav({
  links,
  className = "flex flex-wrap items-center gap-1",
}: {
  links: readonly NavLink[];
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigation secondaire" className={className}>
      {links.map((link) => (
        <NavLinkItem key={link.href} link={link} pathname={pathname} />
      ))}
    </nav>
  );
}
