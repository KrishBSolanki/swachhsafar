import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync, readFileSync } from 'node:fs';

// OPFS and Web Crypto only exist in secure contexts, so LAN devices must use HTTPS.
// Certificate from mkcert (gitignored): mkcert -cert-file .cert/dev-cert.pem -key-file .cert/dev-key.pem <LAN IP> localhost
const certFile = '.cert/dev-cert.pem';
const keyFile = '.cert/dev-key.pem';
const https = existsSync(certFile) && existsSync(keyFile)
  ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
  : undefined;

export default defineConfig(({ isPreview }) => ({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'serviceWorker.js',
      injectRegister: false,
      manifestFilename: 'manifest.json',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,json}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        id: '/',
        name: 'Swachh Safar',
        short_name: 'Swachh Safar',
        description: 'Offline-first Swachh Safar app',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#0f766e',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // Preview falls back to these server options, so they only apply to the dev server.
  // E2E runs preview on plain http://localhost; `npm run preview:lan` serves the build over HTTPS.
  // /api is forwarded to the FastAPI backend (override with API_PROXY_TARGET); production sets VITE_API_BASE_URL.
  server: isPreview ? {} : { host: true, port: 5173, strictPort: true, https, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' } },
  preview: { ...(process.env.PREVIEW_HTTPS ? { https } : {}), proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' } },
  worker: { format: 'es' },
  // sqlite-wasm loads its .wasm via import.meta.url; pre-bundling would break that path.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    testTimeout: 60_000,
  },
}));
