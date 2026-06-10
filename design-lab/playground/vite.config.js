import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  server: { port: 5180 },
  build: {
    rollupOptions: {
      input: {
        gallery: resolve(root, 'index.html'),
        stage: resolve(root, 'experiments/001-stage/index.html'),
        morphology: resolve(root, 'experiments/002-moshi-morphology/index.html'),
        periphery: resolve(root, 'experiments/003-periphery/index.html'),
        gullet: resolve(root, 'experiments/004-gullet/index.html'),
        sporeLedger: resolve(root, 'experiments/005-spore-ledger/index.html'),
        broadcast: resolve(root, 'experiments/006-broadcast/index.html'),
        terrarium: resolve(root, 'experiments/007-terrarium/index.html'),
        possession: resolve(root, 'experiments/008-possession/index.html'),
      },
    },
  },
})
