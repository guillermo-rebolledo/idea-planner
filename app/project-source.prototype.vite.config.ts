import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** PROTOTYPE — serves the throwaway Add Project flow against Argos's real styles. */
const repositoryRoot = resolve(__dirname, '..')

export default defineConfig({
  root: resolve(repositoryRoot, 'prototypes/project-source'),
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
