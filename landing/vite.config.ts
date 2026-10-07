import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Standalone static site — no framework plugin needed (vanilla TS + hand-written
// CSS). `envPrefix` adds PUBLIC_ alongside Vite's default VITE_ so the PUBLIC_* vars
// documented in .env.example and DEPLOY.md are exposed to client code via
// import.meta.env.

/** Link previews (iMessage, Discord, Slack) want an ABSOLUTE og:image URL. The pages
 *  ship a root-relative one; when PUBLIC_SITE_URL is set at build time this rewrites
 *  it to that origin. Unset, the relative URL is left alone. */
function absoluteOgImage(siteUrl: string | undefined): Plugin {
  return {
    name: 'mosh-absolute-og-image',
    transformIndexHtml(html) {
      if (!siteUrl) return html
      const origin = siteUrl.replace(/\/+$/, '')
      return html.replace(/(<meta property="og:image" content=")(\/[^"]*)(")/g, `$1${origin}$2$3`)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'PUBLIC_')
  return {
    envPrefix: ['VITE_', 'PUBLIC_'],
    plugins: [absoluteOgImage(env.PUBLIC_SITE_URL)],
    build: {
      target: 'es2020',
      sourcemap: true,
      rollupOptions: {
        // Two pages: the site (/) and the playtest guide (/playtest/).
        input: {
          main: resolve(__dirname, 'index.html'),
          playtest: resolve(__dirname, 'playtest/index.html'),
        },
      },
    },
    server: {
      port: 5183,
      strictPort: false,
    },
    preview: {
      port: 4183,
    },
  }
})
