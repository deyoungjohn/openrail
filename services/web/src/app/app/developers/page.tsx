import type { Metadata } from "next";
import { DevelopersScreen } from "@/components/setup/developers-screen";

export const metadata: Metadata = { title: "API Integration" };

export default function Page() {
  return <DevelopersScreen />;
}
