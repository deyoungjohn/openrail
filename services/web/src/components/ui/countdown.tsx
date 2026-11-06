"use client";

import { Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { formatLeft } from "@/lib/pay";

export function Countdown({ expiresAt }: { expiresAt: number }) {
  // null until mounted, so server and client render the same markup.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = now === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const urgent = left !== null && left < 120;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[13px] leading-5",
        urgent ? "text-warning" : "text-text",
      )}
    >
      <Timer size={16} strokeWidth={1.5} aria-hidden />
      {left === null ? (
        <span aria-hidden>--:--</span>
      ) : left === 0 ? (
        <span role="status">{copy.countdown.expired}</span>
      ) : (
        <time>
          {formatLeft(left)}
          <span className="sr-only"> {copy.countdown.left}</span>
        </time>
      )}
    </span>
  );
}
