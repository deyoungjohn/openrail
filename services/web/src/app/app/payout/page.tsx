import type { Metadata } from "next";
import { CashoutScreen } from "@/components/w5/cashout-screen";

export const metadata: Metadata = { title: "Cash out" };

export default function Page() {
  return <CashoutScreen />;
}
