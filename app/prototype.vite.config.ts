import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Serves the `subagent-thread` prototype from inside this package.
 *
 * It lives at the repository root, where the lint config treats prototypes as
 * design evidence rather than product code, but the Tailwind and React plugins
 * it needs are this package's dependencies. So the config sits here and points
 * its root back out at it: the prototype can then import the
 * app's real `styles.css` and its real UI primitives, which is the whole point
 * — a prototype drawn in a lookalike palette answers a different question than
 * the one drawn in the product's own.
 */
const repositoryRoot = resolve(__dirname, '..')

export default defineConfig({
  root: resolve(repositoryRoot, 'prototypes/subagent-thread'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5174,
    fs: { allow: [repositoryRoot] }
  }
})
