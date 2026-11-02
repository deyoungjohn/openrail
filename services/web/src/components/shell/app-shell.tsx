"use client";

import {
  ChevronsLeft,
  ChevronsRight,
  CreditCard,
  FileText,
  Code2,
  LayoutDashboard,
  Menu,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { copy } from "@/copy";
import { enabledModules } from "@/enabled";
import { cn } from "@/lib/cn";
import { readStored, writeStored } from "@/lib/storage";
import { Modal } from "../ui/modal";
import { ThemeToggle } from "../ui/theme-toggle";
import { Brand } from "../brand";
import { AccountBar } from "../auth/account-bar";
import { AuthGate } from "../auth/auth-gate";
import { useAuth } from "../auth/auth-provider";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
}

const coreNav: readonly NavItem[] = [
  { href: "/app", label: copy.nav.dashboard, Icon: LayoutDashboard },
  { href: "/app/invoices", label: copy.nav.invoices, Icon: FileText },
  { href: "/app/payments", label: copy.nav.payments, Icon: CreditCard },
  { href: "/app/developers", label: copy.nav.developers, Icon: Code2 },
  { href: "/app/settings", label: copy.nav.settings, Icon: Settings },
];

// Module entries come from the generated registry; the shell names none of them. A module may
// export `nav: { href, label }`; modules without it add no nav entry.
const moduleNav: readonly NavItem[] = enabledModules.flatMap(({ module }) => {
  const nav = (module as { nav?: { href: string; label: string } } | null)?.nav;
  return nav ? [{ href: nav.href, label: nav.label, Icon: FileText }] : [];
});

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label={copy.nav.label}>
      <ul className="space-y-1">
        {[...coreNav, ...moduleNav].map(({ href, label, Icon }) => {
          const active = href === "/app" ? path === href : path.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-[10px] px-3 text-[14px] leading-5 font-medium",
                  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
                  active
                    ? "bg-accent-soft text-accent shadow-[inset_2px_0_0_var(--nav-bar)]"
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
    <Link href="/app" className="flex h-11 items-center px-3">
      <Brand className={collapsed ? "sr-only" : undefined} />
      {collapsed ? (
        <span aria-hidden className="mx-auto text-[18px] leading-6 font-semibold">
          {copy.brand[0]}
        </span>
      ) : null}
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
        </div>
      </aside>

      <div
        className={cn(
          "transition-[padding] duration-[var(--dur)] ease-[var(--ease)]",
          collapsed ? "md:pl-[72px]" : "md:pl-[248px]",
        )}
      >
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg/90 px-4 backdrop-blur md:px-6">
          <button
            type="button"
            onClick={() => setMenu(true)}
            aria-label={copy.nav.openMenu}
            className="grid size-9 place-items-center rounded-[10px] border border-border bg-surface md:hidden"
          >
            <Menu size={18} strokeWidth={1.5} aria-hidden />
          </button>
          <Brand className="text-[16px] leading-6 font-semibold md:hidden" />
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
