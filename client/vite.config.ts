import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `injectManifest`, not `generateSW`: this worker also has to receive push
      // events and flush the offline outbox, which a generated one cannot do.
      // Workbox still handles precaching, from our own file.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
      },
      // Off in dev. A precaching worker turns every source edit into a
      // stale-asset hunt, and the outbox is testable without it.
      devOptions: { enabled: false },
      manifest: {
        name: 'TickIt',
        short_name: 'TickIt',
        description: 'One tap to log.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#08090d',
        theme_color: '#08090d',
        icons: [
          // The vector first, so anything that can scale it does — the mark is
          // geometry, and a 512px raster is a fallback, not the original.
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
