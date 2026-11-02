import type { Metadata } from "next";
import { StatementsScreen } from "@/components/w5/statements-screen";

export const metadata: Metadata = { title: "Statements" };

export default function Page() {
  return <StatementsScreen />;
}
