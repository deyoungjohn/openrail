import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace client ships TypeScript source.
  transpilePackages: ["@openrail/api-client"],
  // The workspace packages import "./x.js" for "./x.ts" (NodeNext style). Turbopack does not map
  // that yet, so the app builds with webpack, which does through extensionAlias.
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    // WalletConnect's logger optionally requires pino-pretty, a Node-only pretty printer.
    config.resolve.alias = {
      ...config.resolve.alias,
      "pino-pretty": false,
      // The Coinbase wallet connector (inside the wagmi connectors the connect dialog lists) names x402 payment
      // packages as optional peers. We never use them, so they resolve to nothing instead of failing the build.
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
    };
    return config;
  },
};

export default config;
