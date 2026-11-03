import type { Metadata } from "next";
import { InvoiceDetailScreen } from "@/components/dash/invoice-detail-screen";

export const metadata: Metadata = { title: "Invoice" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetailScreen id={id} />;
}
