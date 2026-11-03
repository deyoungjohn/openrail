import type { Metadata } from "next";
import { DevelopersScreen } from "@/components/setup/developers-screen";

export const metadata: Metadata = { title: "Developers" };

export default function Page() {
  return <DevelopersScreen />;
}
