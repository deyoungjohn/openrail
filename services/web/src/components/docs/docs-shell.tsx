"use client";

import { ArrowLeft, ArrowRight, ArrowUpRight, Menu, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brand } from "@/components/brand";
import { GitHubButton } from "@/components/landing/nav";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/cn";
import type { Heading } from "@/lib/docs/markdown";
import { DOCS_NAV, DOC_ORDER, docHref } from "@/lib/docs/nav";

const REPO = "https://github.com/deyoungjohn/openrail";

function Sidebar({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Documentation" className="space-y-7">
      {DOCS_NAV.map((g) => (
        <div key={g.group}>
          <p className="px-3 text-[13px] font-semibold tracking-[0.01em] text-text">{g.group}</p>
          <ul className="mt-2 space-y-0.5">
            {g.items.map((it) => {
              const active = it.slug === slug;
              return (
                <li key={it.slug}>
                  <Link
                    href={docHref(it.slug)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-xl px-3 py-2 text-[14.5px] transition-colors",
                      active
                        ? "bg-accent-soft font-semibold text-accent-text"
                        : "text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    {it.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SearchDialog({
  open,
  onClose,
  index,
}: {
  open: boolean;
  onClose: () => void;
  index: { slug: string; title: string; text: string }[];
}) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 10);
    else setQ("");
  }, [open]);
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return DOC_ORDER.slice(0, 8).map((d) => ({ ...d, snippet: "" }));
    return index
      .map((d) => {
        const hay = `${d.title} ${d.text}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return null;
        const score = words.reduce((s, w) => s + (d.title.toLowerCase().includes(w) ? 5 : 1), 0);
        const at = d.text.toLowerCase().indexOf(words[0]!);
        const snippet = at < 0 ? "" : `…${d.text.slice(Math.max(0, at - 50), at + 90)}…`;
        return { slug: d.slug, title: d.title, snippet, score };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [q, index]);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search the docs"
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="w-full max-w-[620px] overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search aria-hidden size={18} className="text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the docs"
            className="h-14 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="rounded-lg p-1.5 hover:bg-surface-2"
          >
            <X aria-hidden size={16} />
          </button>
        </div>
        <ul className="max-h-[56vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="caption px-3 py-6 text-center">Nothing matches “{q}”.</li>
          ) : null}
          {results.map((r) => (
            <li key={r.slug}>
              <Link
                href={docHref(r.slug)}
                onClick={onClose}
                className="block rounded-xl px-3 py-2.5 hover:bg-surface-2"
              >
                <span className="block text-[15px] font-semibold">{r.title}</span>
                {r.snippet ? (
                  <span className="caption mt-0.5 line-clamp-2 block">{r.snippet}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function OnThisPage({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? "");
  useEffect(() => {
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((e): e is HTMLElement => e !== null);
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [headings]);
  if (headings.length === 0) return null;
  return (
    <nav aria-label="On this page" className="text-[14px]">
      <p className="mb-3 font-semibold">On this page</p>
      <ul className="space-y-0.5 border-l border-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                "-ml-px block border-l-2 py-1.5 leading-5 transition-colors",
                h.depth === 3 ? "pl-6" : "pl-3",
                active === h.id
                  ? "border-accent font-medium text-accent-text"
                  : "border-transparent text-muted hover:text-text",
              )}
            >
              {h.text.replace(/`/g, "")}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The docs' frame: top bar with search, sidebar, the page, "On this page", previous and next. */
export function DocsShell({
  slug,
  title,
  lead,
  group,
  headings,
  index,
  children,
}: {
  slug: string;
  title: string;
  lead: string;
  group: string;
  headings: Heading[];
  index: { slug: string; title: string; text: string }[];
  children: ReactNode;
}) {
  const [search, setSearch] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const at = DOC_ORDER.findIndex((d) => d.slug === slug);
  const prev = at > 0 ? DOC_ORDER[at - 1] : undefined;
  const next = at >= 0 && at < DOC_ORDER.length - 1 ? DOC_ORDER[at + 1] : undefined;

  return (
    <div className="relative isolate min-h-dvh bg-bg text-text">
      {/* The accent glow: brightest top left, fading into the page (light and dark). */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(1100px_600px_at_12%_-8%,color-mix(in_oklab,var(--accent)_22%,transparent),transparent_70%),radial-gradient(900px_500px_at_100%_0%,color-mix(in_oklab,var(--accent)_10%,transparent),transparent_70%)]"
      />
      <header className="sticky top-0 z-40 border-b border-border bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open the docs menu"
            className="grid size-10 place-items-center rounded-xl border border-border lg:hidden"
          >
            <Menu aria-hidden size={18} />
          </button>
          <Link href="/" aria-label="Openrail home" className="flex shrink-0 items-center gap-2.5">
            <Brand className="h-7 w-auto" />
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12.5px] font-semibold text-accent-text">
              Docs
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setSearch(true)}
            className="mx-auto hidden h-10 w-full max-w-[460px] items-center gap-2.5 rounded-xl border border-border bg-surface/70 px-3.5 text-[14px] text-muted hover:border-accent/50 md:flex"
          >
            <Search aria-hidden size={16} />
            Search the docs
            <kbd className="ml-auto rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px]">
              Ctrl K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <button
              type="button"
              onClick={() => setSearch(true)}
              aria-label="Search the docs"
              className="grid size-10 place-items-center rounded-xl border border-border md:hidden"
            >
              <Search aria-hidden size={17} />
            </button>
            <GitHubButton />
            <ThemeToggle />
            <Link
              href="/app"
              className="hidden h-10 items-center rounded-full bg-accent px-4 text-[14px] font-semibold text-on-accent hover:bg-accent-hover sm:inline-flex"
            >
              Open the app
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1440px] gap-10 px-4 sm:px-6">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[272px] shrink-0 overflow-y-auto py-8 lg:block">
          <div className="rounded-[22px] border border-border bg-surface/60 p-3 backdrop-blur">
            <Sidebar slug={slug} />
          </div>
        </aside>

        <main className="min-w-0 flex-1 py-10 lg:py-12">
          <article className="mx-auto max-w-[780px]">
            <p className="text-[14px] font-semibold text-accent-text">{group}</p>
            <h1 className="mt-2 text-[clamp(32px,4.5vw,46px)] leading-[1.08] font-extrabold tracking-[-0.03em]">
              {title}
            </h1>
            {lead ? <p className="mt-4 text-[19px] leading-8 text-muted">{lead}</p> : null}
            <div className="mt-8">{children}</div>

            <div className="mt-16 grid gap-4 border-t border-border pt-8 sm:grid-cols-2">
              {prev ? (
                <Link
                  href={docHref(prev.slug)}
                  className="group rounded-2xl border border-border bg-surface/60 p-4 hover:border-accent"
                >
                  <span className="caption flex items-center gap-1.5">
                    <ArrowLeft aria-hidden size={14} /> Previous
                  </span>
                  <span className="mt-1 block text-[16px] font-semibold group-hover:text-accent-text">
                    {prev.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link
                  href={docHref(next.slug)}
                  className="group rounded-2xl border border-border bg-surface/60 p-4 text-right hover:border-accent"
                >
                  <span className="caption flex items-center justify-end gap-1.5">
                    Next <ArrowRight aria-hidden size={14} />
                  </span>
                  <span className="mt-1 block text-[16px] font-semibold group-hover:text-accent-text">
                    {next.title}
                  </span>
                </Link>
              ) : null}
            </div>
            <a
              href={`${REPO}/blob/main/services/web/content/docs/${slug}.md`}
              target="_blank"
              rel="noreferrer"
              className="caption mt-6 inline-flex items-center gap-1.5 hover:text-accent-text"
            >
              Edit this page on GitHub <ArrowUpRight aria-hidden size={13} />
            </a>
          </article>
        </main>

        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[220px] shrink-0 overflow-y-auto py-12 xl:block">
          <OnThisPage headings={headings} />
        </aside>
      </div>

      {drawer ? (
        <div
          className="fixed inset-0 z-[70] bg-black/50 lg:hidden"
          onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}
        >
          <div className="h-full w-[300px] max-w-[85vw] overflow-y-auto border-r border-border bg-bg p-4">
            <div className="mb-4 flex items-center justify-between">
              <Brand className="h-7 w-auto" />
              <button
                type="button"
                onClick={() => setDrawer(false)}
                aria-label="Close the docs menu"
                className="rounded-lg p-2 hover:bg-surface-2"
              >
                <X aria-hidden size={18} />
              </button>
            </div>
            <Sidebar slug={slug} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      ) : null}
      <SearchDialog open={search} onClose={() => setSearch(false)} index={index} />
    </div>
  );
}
