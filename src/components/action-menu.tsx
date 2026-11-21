"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { ChevronDown } from "./ui";

export type ActionMenuItem = {
  href: string;
  label: string;
  /** Second line: what the action does, in a few words. */
  hint?: string;
  /**
   * Marks a file download. It is rendered as a plain `<a download>`: a `<Link>` would
   * start a client navigation to a Route Handler, and the router would keep the export
   * URL as the current route while the browser stays on the page. The next Server
   * Action would then be posted to the export endpoint and fail with a 405.
   */
  download?: boolean;
};

export type ActionMenuGroup = {
  label: string;
  items: readonly ActionMenuItem[];
};

/**
 * A compact "Actions" dropdown for a page header.
 *
 * Built on a native `<details>`, like the mobile navigation: it opens with the keyboard,
 * is announced as expanded or collapsed, and still works without JavaScript. The client
 * code only adds what the element lacks — closing on a click inside the panel (an export
 * link starts a download and would otherwise leave the menu open), on an outside press,
 * on Escape, and after a navigation.
 *
 * The links stay plain `<Link>`s: no action is triggered by opening the menu, and the
 * server keeps authorising every destination.
 */
export function ActionMenu({
  label,
  groups,
  className = "",
}: {
  label: string;
  groups: readonly ActionMenuGroup[];
  className?: string;
}) {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);

  const close = () => {
    if (menu.current) {
      menu.current.open = false;
    }
  };

  // A client navigation keeps the header mounted: close the menu once the route changed.
  useEffect(() => {
    if (menu.current) {
      menu.current.open = false;
    }
  }, [pathname]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const element = menu.current;
      if (element?.open && !element.contains(event.target as Node)) {
        element.open = false;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const element = menu.current;
      if (event.key !== "Escape" || !element?.open) {
        return;
      }

      element.open = false;
      element.querySelector("summary")?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <details ref={menu} className={`group/menu relative ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open/menu:rotate-180 dark:text-zinc-400" />
      </summary>

      <div
        className="absolute right-0 z-30 mt-1 flex w-80 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
        aria-label={label}
      >
        {groups.map((group) => (
          <div key={group.label} className="py-1">
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {group.label}
            </p>

            {group.items.map((item) => {
              const className =
                "block rounded-md px-2 py-1.5 hover:bg-zinc-100 focus-visible:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800";
              const body = (
                <>
                  <span className="block text-sm">{item.label}</span>
                  {item.hint ? (
                    <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                      {item.hint}
                    </span>
                  ) : null}
                </>
              );

              return item.download ? (
                <a
                  key={`${item.href}|${item.label}`}
                  href={item.href}
                  download
                  onClick={close}
                  className={className}
                >
                  {body}
                </a>
              ) : (
                <Link
                  key={`${item.href}|${item.label}`}
                  href={item.href}
                  onClick={close}
                  className={className}
                >
                  {body}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}
