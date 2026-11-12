// GITHUB_PAGES=true (set by .github/workflows/nextjs.yml) builds a static
// export served under /<repo-name>. Normal `next dev` / `next build` are
// unaffected.
const isPages = process.env.GITHUB_PAGES === 'true';
const basePath = isPages ? '/Bank-' : '';

// Security headers apply to the normal server build. A static export (GitHub
// Pages demo) cannot set response headers, so they are skipped there.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
];

const path = require('path');
const standalone = process.env.NEXT_STANDALONE === 'true' && !isPages;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: path.join(__dirname, '../../') } : {}),
  ...(isPages
    ? {}
    : {
        async headers() {
          return [{ source: '/:path*', headers: securityHeaders }];
        },
      }),
  ...(isPages ? { output: 'export', basePath, assetPrefix: basePath, images: { unoptimized: true } } : {}),
};

module.exports = nextConfig;
