import { defineConfig } from 'vite';

// `./` works for GitHub Pages project sites and local preview.
// Override with VITE_BASE=/repo-name/ when needed.
export default defineConfig({
  base: process.env.VITE_BASE || './',
  server: {
    port: 5173,
    open: true
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
