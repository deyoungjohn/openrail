import type { Metadata } from "next";
import { ReceiptScreen } from "@/components/w5/receipt-screen";
import { PublicShell } from "@/components/shell/public-shell";

export const metadata: Metadata = { title: "Payment receipt", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return (
    <PublicShell>
      <ReceiptScreen hash={hash} />
    </PublicShell>
  );
}
