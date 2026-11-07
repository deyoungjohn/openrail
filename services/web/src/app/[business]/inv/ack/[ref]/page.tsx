import type { Metadata } from "next";
import { AckByRef } from "@/components/pay/invoice-ref";
import { PublicShell } from "@/components/shell/public-shell";

export const metadata: Metadata = { title: "Accept invoice", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return (
    <PublicShell>
      <AckByRef invoiceRef={ref} />
    </PublicShell>
  );
}
