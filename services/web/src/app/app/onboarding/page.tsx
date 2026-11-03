import type { Metadata } from "next";
import { OnboardingScreen } from "@/components/setup/onboarding-screen";

export const metadata: Metadata = { title: "Get started" };

export default function Page() {
  return <OnboardingScreen />;
}
