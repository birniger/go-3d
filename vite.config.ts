import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  // Use relative base so the build works both on GitHub Pages
  // (https://birniger.github.io/go-3d/) and inside the WordPress plugin, where
  // assets are served from wp-content/plugins/go3d/assets/dist/.
  base: './',
  build: {
    // Three.js minifies to ~540 kB — raise the warning threshold accordingly
    chunkSizeWarningLimit: 600,
    // Emit .vite/manifest.json so the WP shortcode can resolve the hashed
    // filenames of the app entry + its CSS.
    manifest: true,
    rollupOptions: {
      input: {
        // Standalone hot-seat game (index.html → main.ts) for GitHub Pages.
        main: resolve(__dirname, 'index.html'),
        // Multiplayer entry loaded by the [go3d] WordPress shortcode.
        app: resolve(__dirname, 'src/app.ts'),
      },
    },
  },
})
