import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle for the Docker runtime stage.
  output: "standalone",

  serverExternalPackages: ["@prisma/adapter-pg"],

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.ytimg.com" },
      { protocol: "https", hostname: "yt3.ggpht.com" },
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },

  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
