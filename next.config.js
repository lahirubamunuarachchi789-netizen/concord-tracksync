/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdfkit relies on Node.js built-ins (fs, path); let Next.js treat it as an
  // external server dependency so it is not bundled by the webpack optimizer.
  serverExternalPackages: ['pdfkit'],
};

module.exports = nextConfig;

