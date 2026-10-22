import { defineConfig } from 'vite';

// Squarespace site holding the two collections the bridge reads.
// Override with VITE_SQSP_ORIGIN=https://staging.example.com npm run dev.
const SQSP_ORIGIN = process.env.VITE_SQSP_ORIGIN || 'https://www.ouiquebec.org';

// `./` works for GitHub Pages project sites and local preview.
// Override with VITE_BASE=/repo-name/ when needed.
export default defineConfig({
  base: process.env.VITE_BASE || './',
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Both COLLECTION_PATHS (content-models.js) share this prefix. Proxying
      // keeps them same-origin in dev: Squarespace sends no CORS headers, and
      // the bridge rejects cross-origin collection URLs anyway.
      '/carte-tables-': {
        target: SQSP_ORIGIN,
        changeOrigin: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/embed.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
