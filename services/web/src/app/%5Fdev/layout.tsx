import { notFound } from "next/navigation";
import type { ReactNode } from "react";

// Dev-only routes exist only when the server starts with OPENRAIL_DEV_ROUTES=1.
export const dynamic = "force-dynamic";

export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.OPENRAIL_DEV_ROUTES !== "1") notFound();
  return children;
}
