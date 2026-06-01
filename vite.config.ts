import { defineConfig } from 'vite'

export default defineConfig({
  // Use relative base so the build works both on GitHub Pages
  // (https://birniger.github.io/go-3d/) and local preview
  base: './',
  build: {
    // Three.js minifies to ~540 kB — raise the warning threshold accordingly
    chunkSizeWarningLimit: 600,
  },
})
