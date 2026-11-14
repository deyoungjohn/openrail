import type { Metadata } from "next";
import { ChainsMarquee, Faq, Features, Showcase } from "@/components/landing/more";
import { LandingNav } from "@/components/landing/nav";
import { Reveal } from "@/components/motion/reveal";
import { loadProofRows } from "@/lib/proof-data";
import {
  Band,
  DashboardShot,
  Global,
  Growth,
  Hero,
  LandingFooter,
  OnChain,
  TwoCards,
} from "@/components/landing/sections";

export const metadata: Metadata = {
  title: "Openrail: get paid in stablecoins, from any chain",
  description:
    "Invoices and checkout for businesses. Clients pay from eight chains; you receive USDC where you choose, and every payment is proven on NEAR.",
};

// The onchain strip reads the Proof data again at most once a minute.
export const revalidate = 60;

export default async function Landing() {
  const { rows } = await loadProofRows();
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav />
      <main>
        <Hero />
        <Reveal>
          <ChainsMarquee />
        </Reveal>
        <DashboardShot />
        <TwoCards />
        <Reveal>
          <Global />
        </Reveal>
        <Growth />
        <Features />
        <Showcase />
        <Reveal>
          <Band />
        </Reveal>
        <Reveal>
          <OnChain proof={rows} />
        </Reveal>
        <Faq />
      </main>
      <LandingFooter />
    </div>
  );
}
