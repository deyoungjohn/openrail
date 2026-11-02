import type { Metadata } from "next";
import { AckScreen } from "@/components/claim/ack-screen";
import { PublicShell } from "@/components/shell/public-shell";

export const metadata: Metadata = { title: "Accept invoice", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return (
    <PublicShell>
      <AckScreen tokenId={tokenId} />
    </PublicShell>
  );
}
