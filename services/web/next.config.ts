import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace client ships TypeScript source.
  transpilePackages: ["@openrail/api-client"],
  // The workspace packages import "./x.js" for "./x.ts" (NodeNext style). Turbopack does not map
  // that yet, so the app builds with webpack, which does through extensionAlias.
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default config;
