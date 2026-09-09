import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readPackagedChangelog, readPackagedHistory } from './scripts/packaged-changelog'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __PACKAGED_CHANGELOG__: JSON.stringify(readPackagedChangelog(__dirname, process.env.CC_HAHA_REQUIRE_CHANGELOG === '1')),
    __PACKAGED_CHANGELOG_HISTORY__: JSON.stringify(readPackagedHistory(__dirname)),
  },
  build: {
    // Vite 8 defaults to baseline-widely-available (safari16.4+), which
    // requires macOS 13+. Tauri on macOS 12 uses Safari 15 WebView.
    target: ['es2021', 'safari15'],
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
