import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Openrail", template: "%s · Openrail" },
  description: "Get paid in USDC from any chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes writes data-theme before first paint, hence suppressHydrationWarning.
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
