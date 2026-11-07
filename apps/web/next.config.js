// GITHUB_PAGES=true (set by .github/workflows/nextjs.yml) builds a static
// export served under /<repo-name>. Normal `next dev` / `next build` are
// unaffected.
const isPages = process.env.GITHUB_PAGES === 'true';
const basePath = isPages ? '/Bank-' : '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isPages ? { output: 'export', basePath, assetPrefix: basePath, images: { unoptimized: true } } : {}),
};

module.exports = nextConfig;
