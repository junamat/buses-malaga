/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Next 14 requiere activar `instrumentation.ts` explícitamente. Se usa para
    // arrancar el worker de ingesta en modo local-postgres (lib/ingestWorker.ts).
    instrumentationHook: true,
  },
};

export default nextConfig;
