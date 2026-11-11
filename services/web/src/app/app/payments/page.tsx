import type { Metadata } from "next";
import { PaymentsScreen } from "@/components/dash/payments-screen";

export const metadata: Metadata = { title: "Payments" };

export default function Page() {
  return <PaymentsScreen />;
}
