import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  server: { port: 5180 },
  build: {
    rollupOptions: {
      input: { stage: resolve(root, 'index.html') },
    },
  },
})
