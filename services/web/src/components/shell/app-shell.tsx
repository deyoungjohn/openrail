"use client";

import {
  Banknote,
  ChevronsLeft,
  ChevronsRight,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Code2,
  LayoutDashboard,
  Menu,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copy } from "@/copy";
import { enabledModules } from "@/enabled";
import { cn } from "@/lib/cn";
import { readStored, writeStored } from "@/lib/storage";
import { Modal } from "../ui/modal";
import { ThemeToggle } from "../ui/theme-toggle";
import { Brand, BrandMark } from "../brand";
import { AccountBar } from "../auth/account-bar";
import { AuthGate } from "../auth/auth-gate";
import { useAuth } from "../auth/auth-provider";
import { Tooltip } from "../ui/tooltip";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
}

const coreNav: readonly NavItem[] = [
  { href: "/app", label: copy.nav.dashboard, Icon: LayoutDashboard },
  { href: "/app/invoices", label: copy.nav.invoices, Icon: FileText },
  { href: "/app/payments", label: copy.nav.payments, Icon: CreditCard },
  { href: "/app/statements", label: copy.nav.statements, Icon: FileSpreadsheet },
  { href: "/app/cashout", label: copy.nav.cashout, Icon: Banknote },
  { href: "/app/developers", label: copy.nav.developers, Icon: Code2 },
  { href: "/app/settings", label: copy.nav.settings, Icon: Settings },
];

// Module entries come from the generated registry; the shell names none of them. A module may
// export `nav: { href, label }`; modules without it add no nav entry.
const moduleNav: readonly NavItem[] = enabledModules.flatMap(({ module }) => {
  const nav = (module as { nav?: { href: string; label: string } } | null)?.nav;
  return nav ? [{ href: nav.href, label: nav.label, Icon: FileText }] : [];
});

/**
 * A sidebar click that the router does not complete (its request for the next page never answers, or fails) left
 * people on the old page until they reloaded. If the path has not changed 1.6 s after the click, go there the plain
 * way: a full page load always works, and the loading skeleton covers it.
 */
const STUCK_MS = 1600;

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // the path moved: the router did its work
    if (watchdog.current !== null) clearTimeout(watchdog.current);
    watchdog.current = null;
  }, [path]);
  useEffect(
    () => () => {
      if (watchdog.current !== null) clearTimeout(watchdog.current);
    },
    [],
  );
  const watch = (href: string) => {
    if (watchdog.current !== null) clearTimeout(watchdog.current);
    if (href === path) return;
    watchdog.current = setTimeout(() => {
      if (window.location.pathname !== href) window.location.assign(href);
    }, STUCK_MS);
  };
  return (
    <nav aria-label={copy.nav.label}>
      <ul className="space-y-1">
        {[...coreNav, ...moduleNav].map(({ href, label, Icon }) => {
          const active = href === "/app" ? path === href : path.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={(e) => {
                  onNavigate?.();
                  // a modified click (new tab) is the browser's own
                  if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) watch(href);
                }}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-[10px] px-3 text-[14px] leading-5 font-medium",
                  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
                  active
                    ? "relative bg-accent-soft text-accent-text before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                    : "text-text hover:bg-surface-2",
                  collapsed && "justify-center px-0",
                )}
              >
                <Icon size={20} strokeWidth={1.5} aria-hidden />
                <span className={collapsed ? "sr-only" : undefined}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SidebarBrand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link href="/app" className="flex h-11 items-center px-3" aria-label={copy.brand}>
      {collapsed ? <BrandMark className="mx-auto h-6 w-auto" /> : <Brand className="h-7 w-auto" />}
    </Link>
  );
}

const KEY = "openrail.sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState(false);
  const path = usePathname();

  useEffect(() => setCollapsed(readStored(KEY) === "collapsed"), []);
  const { state: authState } = useAuth();
  useEffect(() => setMenu(false), [path, authState.status]);

  const toggle = () => {
    setCollapsed((c) => {
      writeStored(KEY, c ? "open" : "collapsed");
      return !c;
    });
  };

  return (
    <div className="min-h-dvh">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {copy.nav.skip}
      </a>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-sidebar p-3 md:flex",
          "transition-[width] duration-[var(--dur)] ease-[var(--ease)]",
          collapsed ? "w-[72px]" : "w-[248px]",
        )}
      >
        <SidebarBrand collapsed={collapsed} />
        <div className="mt-4 flex-1 overflow-y-auto">
          <NavList collapsed={collapsed} />
        </div>
        <div
          className={cn("flex items-center gap-2 pt-3", collapsed ? "flex-col" : "justify-between")}
        >
          <ThemeToggle />
          <Tooltip label={collapsed ? copy.nav.expand : copy.nav.collapse} side="top">
            <button
              type="button"
              onClick={toggle}
              aria-label={collapsed ? copy.nav.expand : copy.nav.collapse}
              className="grid size-9 place-items-center rounded-[10px] text-muted hover:bg-surface-2"
            >
              {collapsed ? (
                <ChevronsRight size={18} strokeWidth={1.5} aria-hidden />
              ) : (
                <ChevronsLeft size={18} strokeWidth={1.5} aria-hidden />
              )}
            </button>
          </Tooltip>
        </div>
      </aside>

      <div
        className={cn(
          "transition-[padding] duration-[var(--dur)] ease-[var(--ease)]",
          collapsed ? "md:pl-[72px]" : "md:pl-[248px]",
        )}
      >
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg px-4 md:px-6">
          <Tooltip label={copy.nav.openMenu} side="bottom">
            <button
              type="button"
              onClick={() => setMenu(true)}
              aria-label={copy.nav.openMenu}
              className="grid size-9 place-items-center rounded-[10px] border border-border bg-surface md:hidden"
            >
              <Menu size={18} strokeWidth={1.5} aria-hidden />
            </button>
          </Tooltip>
          <Brand className="h-6 w-auto md:hidden" />
          <div className="ml-auto hidden items-center gap-3 sm:flex">
            <AccountBar />
          </div>
          <ThemeToggle className="md:hidden" />
        </header>

        <main id="content" className="route-rise mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6">
          <AuthGate>{children}</AuthGate>
        </main>
      </div>

      <Modal open={menu} onClose={() => setMenu(false)} title={copy.brand} variant="drawer">
        <NavList collapsed={false} onNavigate={() => setMenu(false)} />
        <div className="mt-6 space-y-3 border-t border-border pt-4">
          <AccountBar />
        </div>
      </Modal>
    </div>
  );
}
