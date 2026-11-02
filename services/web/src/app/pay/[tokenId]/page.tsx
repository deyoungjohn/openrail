import type { Metadata } from "next";
import { PayScreen } from "@/components/pay/pay-screen";
import { PublicShell } from "@/components/shell/public-shell";

export const metadata: Metadata = { title: "Pay invoice", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return (
    <PublicShell wide>
      <PayScreen tokenId={tokenId} />
    </PublicShell>
  );
}
