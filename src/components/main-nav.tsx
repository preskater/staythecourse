"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export type NavLink = { href: string; label: string };

/**
 * Navigation only: no sensitive data and no authorisation decision here. The links
 * arrive already filtered by the server layout from the workspace's active modules.
 *
 * `MainNav` is the module row, from `lg` up; the always-present entries live in
 * `UtilityNav` so the module row stays short. `MobileNav` is the burger built on a
 * native `<details>`, so it opens with the keyboard and is announced as expanded or
 * collapsed without extra ARIA; `children` is what the menu shows under the links on
 * small screens (the utility links and the account controls).
 */
export function NavLinkItem({ link, pathname }: { link: NavLink; pathname: string | null }) {
  const isActive = pathname === link.href || pathname?.startsWith(`${link.href}/`) === true;

  return (
    <Link
      href={link.href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          : "rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }
    >
      {link.label}
    </Link>
  );
}

export function MainNav({
  links,
  className = "",
}: {
  links: readonly NavLink[];
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navigation principale"
      className={`hidden flex-wrap gap-1 lg:flex ${className}`}
    >
      {links.map((link) => (
        <NavLinkItem key={link.href} link={link} pathname={pathname} />
      ))}
    </nav>
  );
}

export function MobileNav({
  links,
  children,
}: {
  links: readonly NavLink[];
  children?: React.ReactNode;
}) {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);

  // A client navigation keeps the header mounted: close the menu once the route changed.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);

  return (
    <details ref={menu} className="group/menu ml-auto lg:hidden">
      <summary
        aria-label="Menu"
        className="flex cursor-pointer list-none items-center rounded-md border border-zinc-300 p-2 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 group-open/menu:hidden">
          <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="hidden h-5 w-5 group-open/menu:block">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </summary>

      <div className="absolute inset-x-0 top-full z-20 flex flex-col gap-3 border-b border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <nav aria-label="Navigation principale" className="flex flex-col gap-1">
          {links.map((link) => (
            <NavLinkItem key={link.href} link={link} pathname={pathname} />
          ))}
        </nav>
        {children}
      </div>
    </details>
  );
}
