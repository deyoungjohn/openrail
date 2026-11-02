import type { Metadata } from "next";
import { TransferScreen } from "@/components/claim/transfer-screen";

export const metadata: Metadata = { title: "Sell invoice" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TransferScreen tokenId={id} />;
}
