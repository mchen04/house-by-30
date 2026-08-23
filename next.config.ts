import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import { normalizeDeploymentId } from "./src/pwa/deployment-id";

if (process.env.NEXT_DEPLOYMENT_ID) {
  process.env.NEXT_DEPLOYMENT_ID = normalizeDeploymentId(
    process.env.NEXT_DEPLOYMENT_ID,
  );
}

function deploymentVersion(): string {
  const configured =
    process.env.NEXT_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_SHA;
  if (configured) return normalizeDeploymentId(configured);
  try {
    return normalizeDeploymentId(
      execFileSync("git", ["rev-parse", "--short=16", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    return "development";
  }
}

const deploymentId = deploymentVersion();
process.env.NEXT_DEPLOYMENT_ID = deploymentId;

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  deploymentId,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-House-By-30-Build", value: deploymentId },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
  experimental: {
    runtimeServerDeploymentId: false,
  },
};

export default nextConfig;
