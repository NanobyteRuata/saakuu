import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Server-only packages that must not be bundled into route handlers.
  serverExternalPackages: ["bullmq", "ioredis", "@prisma/client", "sharp"],
};

export default nextConfig;
