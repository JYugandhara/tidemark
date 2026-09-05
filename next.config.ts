import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for the Docker image, which then does
  // not need to ship node_modules. Off for local builds: `next start` is the
  // documented way to run locally and warns when standalone output is on, and
  // a warning nobody needs to act on is noise in a first-run log.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // `pg` is a native-ish dependency; keep it external so the server bundle
  // does not try to trace it into the edge runtime.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
