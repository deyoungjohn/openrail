import { cn } from "@/lib/cn";
import { Skeleton } from "./state";

/**
 * What a page looks like before it has anything to say: the frame of a real page (a heading and its line of text,
 * buttons, a row of stat cards, cards with text, a table) from the top to the bottom of the screen. It is the first
 * thing seen on a load or a reload, so the page does not appear in pieces. The dashboard keeps its own, more exact one.
 */
function CardBlock({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div className={cn("surface-card flex flex-col gap-3 p-5 sm:p-6", className)}>
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

function Stat() {
  return (
    <div className="surface-card min-h-[128px] space-y-3 p-5">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

function TableBlock({ rows = 6 }: { rows?: number }) {
  return (
    <div className="surface-card flex flex-1 flex-col p-0">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-44 rounded-full" />
      </div>
      <div className="flex-1 divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4 sm:px-6">
            <Skeleton className="h-4 w-1/5" />
            <Skeleton className="h-4 w-1/6" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageSkeleton({ variant = "app" }: { variant?: "app" | "public" }) {
  if (variant === "public") {
    return (
      <div
        role="status"
        aria-busy
        aria-label="Loading"
        className="mx-auto grid min-h-[calc(100dvh-10rem)] w-full max-w-5xl content-start gap-6 lg:grid-cols-2 lg:items-stretch lg:gap-8"
      >
        <div className="surface-card space-y-5 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="w-2/3 space-y-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-7 w-full" />
            </div>
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
          <Skeleton className="h-12 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
          <div className="grid grid-cols-2 gap-4 pt-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-10 w-40 rounded-[10px]" />
        </div>
        <div className="surface-card space-y-4 p-5 sm:p-6">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-11 w-full rounded-full" />
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
          <Skeleton className="h-14 w-full" />
          <div className="flex justify-center">
            <Skeleton className="h-11 w-36 rounded-[10px]" />
          </div>
        </div>
        <div className="lg:col-span-2">
          <CardBlock lines={5} />
        </div>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-busy
      aria-label="Loading"
      className="mx-auto flex min-h-[calc(100dvh-8rem)] w-full max-w-6xl flex-col gap-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-10 w-28 rounded-[10px]" />
          <Skeleton className="h-10 w-36 rounded-[10px]" />
        </div>
      </div>
      <div className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat />
        <Stat />
        <Stat />
        <Stat />
      </div>
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <CardBlock lines={4} />
        <CardBlock lines={4} />
      </div>
      <TableBlock />
    </div>
  );
}
