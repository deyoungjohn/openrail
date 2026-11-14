"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { EvmProvider } from "@/wallet/evm";
import { NearProvider } from "@/wallet/near";
import { SolanaProvider } from "@/wallet/solana";
import { ToastProvider } from "./ui/toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
      <ToastProvider>
        <NearProvider>
          <EvmProvider>
            <SolanaProvider>{children}</SolanaProvider>
          </EvmProvider>
        </NearProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
