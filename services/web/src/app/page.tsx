import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { copy } from "@/copy";

// Placeholder. The real landing page (DESIGN.md 7.1) is a later work package.
export default function Landing() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1200px] flex-col px-4">
      <header className="flex h-16 items-center justify-between">
        <span className="text-[18px] font-semibold">{copy.brand}</span>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 flex-col items-start justify-center gap-6 py-16">
        <span className="rounded-full bg-accent-soft px-3 py-1 text-[13px] font-medium text-accent-text">
          {copy.landing.badge}
        </span>
        <h1 className="text-[clamp(32px,7vw,64px)] leading-[1.05] font-extrabold tracking-[-0.03em]">
          {copy.landing.title}
        </h1>
        <p className="max-w-xl text-[18px] leading-7">{copy.landing.body}</p>
        <Link
          href="/app"
          className="inline-flex h-11 items-center rounded-[10px] bg-accent px-5 text-[14px] font-medium text-on-accent hover:bg-accent-hover"
        >
          {copy.landing.cta}
        </Link>
      </main>
    </div>
  );
}
