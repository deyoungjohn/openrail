import type { Metadata } from "next";
import { Suspense } from "react";
import { StatementsScreen } from "@/components/w5/statements-screen";

export const metadata: Metadata = { title: "Statements" };

export default function Page() {
  // useSearchParams needs a Suspense boundary on a statically rendered page.
  return (
    <Suspense>
      <StatementsScreen />
    </Suspense>
  );
}
