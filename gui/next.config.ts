import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
