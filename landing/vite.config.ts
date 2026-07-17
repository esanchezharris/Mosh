import { defineConfig } from 'vite'

// Standalone static site — no framework plugin needed (vanilla TS + hand-written
// CSS). `envPrefix` adds PUBLIC_ alongside Vite's default VITE_ so the
// PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY / PUBLIC_WAITLIST_URL /
// PUBLIC_WAITLIST_SOURCE vars documented in .env.example and DEPLOY.md are
// actually exposed to client code via import.meta.env.
export default defineConfig({
  envPrefix: ['VITE_', 'PUBLIC_'],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  server: {
    port: 5183,
    strictPort: false,
  },
  preview: {
    port: 4183,
  },
})
