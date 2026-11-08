import type { Metadata } from "next";
import { AckByRef } from "@/components/pay/invoice-ref";
import { PublicShell } from "@/components/shell/public-shell";

export const metadata: Metadata = { title: "Accept invoice", robots: { index: false } };

export default async function Page({
  params,
}: {
  params: Promise<{ business: string; ref: string }>;
}) {
  const { business, ref } = await params;
  return (
    <PublicShell>
      <AckByRef invoiceRef={ref} business={business} />
    </PublicShell>
  );
}
