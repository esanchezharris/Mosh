import { defineConfig, loadEnv } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

// THE BRAIN PROXY — keys live ONLY here (server side); the browser talks to
// same-origin /api/brain/* and never sees a credential. All three providers
// (DeepSeek, OpenAI, xAI/Grok) speak OpenAI-compatible /chat/completions, so
// one forwarder serves all — the only fork is GPT-5/o-series param naming.
function moshiBrain(env) {
  const P = {
    deepseek: { url: env.DEEPSEEK_BASE_URL, key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL, label: 'DEEPSEEK' },
    openai:   { url: env.OPENAI_BASE_URL,   key: env.OPENAI_API_KEY,   model: env.OPENAI_MODEL,   label: 'OPENAI'   },
    xai:      { url: env.XAI_BASE_URL,      key: env.XAI_API_KEY,      model: env.XAI_MODEL,      label: 'GROK'     },
  }
  const ok = n => !!(P[n] && P[n].key && P[n].url && P[n].model)
  const def = ok(env.MOSHI_BRAIN_PROVIDER) ? env.MOSHI_BRAIN_PROVIDER
            : (Object.keys(P).find(ok) || null)
  const json = (res, code, obj) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(obj))
  }
  return {
    name: 'moshi-brain',
    configureServer(server) {
      server.middlewares.use('/api/brain/providers', (req, res) => {
        const providers = Object.keys(P).filter(ok).map(n => ({ id: n, label: P[n].label, model: P[n].model }))
        json(res, 200, { default: def, providers })
      })
      server.middlewares.use('/api/brain/chat', (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        let raw = ''
        req.on('data', c => (raw += c))
        req.on('end', async () => {
          try {
            const body = JSON.parse(raw || '{}')
            const name = ok(body.provider) ? body.provider : def
            const p = name && P[name]
            if (!p) return json(res, 503, { error: 'no provider configured — fill design-lab/playground/.env.local' })
            const isNew = name === 'openai' && /^(gpt-5|gpt-6|o[0-9])/.test(p.model)
            const payload = {
              model: p.model,
              messages: body.messages,
              response_format: { type: 'json_object' },
            }
            // Generous cap: v4/GPT-5/o-series are REASONING models — the budget
            // covers hidden reasoning + the JSON, so a short reply isn't clipped
            // mid-object (which would break the parse). The reply is still short.
            if (isNew) payload.max_completion_tokens = 700
            else { payload.max_tokens = 700; payload.temperature = body.temperature ?? 0.85 }
            const t0 = Date.now()
            const r = await fetch(`${p.url}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
              body: JSON.stringify(payload),
            })
            const j = await r.json().catch(() => ({}))
            const ms = Date.now() - t0
            if (!r.ok) return json(res, 502, { error: j.error || j || 'upstream error', provider: name, ms })
            json(res, 200, { provider: name, label: p.label, model: p.model, ms, content: j.choices?.[0]?.message?.content ?? '' })
          } catch (e) {
            json(res, 500, { error: String((e && e.message) || e) })
          }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '') // '' → load ALL keys (incl. unprefixed); SERVER-SIDE ONLY, never defined into the client bundle
  return {
    server: { port: 5180 },
    plugins: [moshiBrain(env)],
    build: {
      rollupOptions: { input: { stage: resolve(root, 'index.html') } },
    },
  }
})
