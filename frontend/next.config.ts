import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Host-run frontend and backend share onboarding/.env. Existing process values
// (including the active backend address and credentials) retain precedence.
const sharedEnv = resolve(process.cwd(), "../.env");
if (existsSync(sharedEnv)) process.loadEnvFile(sharedEnv);
process.env.NEXT_PUBLIC_QUALITY_LAB_ENABLED ??= process.env.QUALITY_LAB_ENABLED ?? "false";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", ...(process.env.PUBLIC_BASE_URL ? [new URL(process.env.PUBLIC_BASE_URL).hostname] : [])],
  turbopack: {
    root: process.cwd(),
    // OpenCV.js ships Node fallbacks in the same UMD bundle. They are never
    // executed inside our browser worker, but Turbopack still resolves them.
    resolveAlias: {
      fs: "./src/lib/empty-node-module.ts",
      crypto: "./src/lib/empty-node-module.ts",
    },
  },
};

export default nextConfig;
