import type { Metadata } from "next";
import { InvoicesScreen } from "@/components/dash/invoices-screen";

export const metadata: Metadata = { title: "Invoices" };

export default function Page() {
  return <InvoicesScreen />;
}
