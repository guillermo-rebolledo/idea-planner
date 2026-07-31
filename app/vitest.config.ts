import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/core/**/*.test.ts', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts']
  }
})
