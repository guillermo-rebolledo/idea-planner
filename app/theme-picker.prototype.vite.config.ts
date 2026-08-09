import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Serves the throwaway theme-picker prototype against the app's real design tokens. */
const repositoryRoot = resolve(__dirname, '..')

export default defineConfig({
  root: resolve(repositoryRoot, 'prototypes/theme-picker'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5177,
    fs: { allow: [repositoryRoot] }
  }
})
