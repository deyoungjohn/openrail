"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copy } from "@/copy";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

type Tone = "success" | "info" | "error";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const Ctx = createContext<{ push: (t: Omit<ToastItem, "id">) => void } | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx.push;
}

const icons = { success: CheckCircle2, info: Info, error: AlertCircle } as const;
const toneClass = { success: "text-success", info: "text-info", error: "text-danger" } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = ++seq.current;
      setItems((l) => [...l, { ...t, id }]);
      // Auto-dismiss after 5 s. Errors that need action should use an inline ErrorState instead.
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 left-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-96">
        {items.map((t) => {
          const Icon = icons[t.tone];
          return (
            <div
              key={t.id}
              role="status"
              className="glass route-rise pointer-events-auto flex w-full items-start gap-3 p-4"
            >
              <Icon
                size={20}
                strokeWidth={1.5}
                className={cn("mt-0.5 shrink-0", toneClass[t.tone])}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] leading-5 font-medium">{t.title}</p>
                {t.body ? <p className="caption">{t.body}</p> : null}
              </div>
              <Tooltip label={copy.toast.dismiss} side="top">
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label={copy.toast.dismiss}
                  className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2"
                >
                  <X size={16} strokeWidth={1.5} aria-hidden />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
