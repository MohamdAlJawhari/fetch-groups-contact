import type { NextConfig } from 'next';

// One origin (docs/specs/07-frontend.md 3): /api/* goes to the backend with the prefix stripped.
// In production Caddy does the same before requests reach Next.js, so this rule only matters in development.
const backend = (process.env.BACKEND_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // This folder is the project root, so a stray package-lock.json further up (e.g. in the user folder) is never used.
  turbopack: { root: __dirname },
  reactStrictMode: true,
  experimental: {
    // The rewrite proxy gives up after 30 s by default, but an export sends nothing until every member is fetched
    // (up to 5 minutes for ~10k members, NFR), so give it more than the backend's own limits.
    proxyTimeout: 11 * 60_000,
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backend}/:path*` }];
  },
};

export default nextConfig;
