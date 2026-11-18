import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.0.183"],
  devIndicators: false,
  transpilePackages: ["@lore-portal/shared"],
  poweredByHeader: false,
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` },
      { source: "/oauth/:path*", destination: `${apiInternalUrl}/oauth/:path*` },
      { source: "/health_check", destination: `${apiInternalUrl}/health_check` },
      {
        source: "/.well-known/:path*",
        destination: `${apiInternalUrl}/.well-known/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
