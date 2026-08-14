import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle for the Docker runtime stage.
  output: "standalone",

  serverExternalPackages: ["@prisma/adapter-pg"],

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.ytimg.com" },
      { protocol: "https", hostname: "yt3.ggpht.com" },
    ],
  },

  /**
   * The app served no security headers at all. These three are the ones that
   * matter for a site whose front door is a password form.
   *
   * `frame-ancestors 'none'` (with the older X-Frame-Options beside it for
   * anything that still only understands that) is the load-bearing one: with
   * nothing set, any page anywhere could load /sign-in in an invisible frame
   * and dress its own chrome around it. That is a clickjacking bug, and it is
   * also literally how a "deceptive page" gets built out of a legitimate one —
   * the real login form, framed inside someone else's story about what it is
   * for. Only frame-ancestors is set, not a full Content-Security-Policy: a
   * script-src policy needs the app's own inline/eval surface mapped first,
   * and a half-tested CSP that breaks the studio is worse than none.
   *
   * `nosniff` stops a browser second-guessing the content type on the routes
   * that stream renders and narration. `strict-origin-when-cross-origin` keeps
   * the path of an operator's page — which can carry a video id — out of the
   * Referer sent to third parties.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },

  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
