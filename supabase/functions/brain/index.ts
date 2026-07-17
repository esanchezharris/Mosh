// Mosh brain proxy — the cloud backend that holds LLM provider keys SERVER-SIDE so a
// packaged app build never bundles an extractable key. It replaces (additively — see
// src/brain/BrainProxy.cpp) the prior posture where the app shipped Contents/Resources/
// brain.env with real provider keys inside the .app bundle, readable by anyone who
// unzipped it.
//
// Mirrors THREE existing brain entry points so all of them agree on provider behaviour —
// only the key custody differs:
//   - ui/vite.config.ts's moshiBrain dev middleware (deepseek → openai → xai chain)
//   - service/brain_client.py (the Python mirror, used by the lyric-generation loop)
//   - src/brain/BrainProxy.cpp (the packaged-app native path)
// Keys live ONLY in Supabase secrets (Deno.env.get, set via `supabase secrets set` —
// see docs/brain-proxy/RUNBOOK.md), are NEVER echoed back to the client, and this
// function's success response carries nothing but { ok, content } — no provider id,
// no model name, no token counts. (Mosh's house principle: "Mosh doesn't invent — it
// transforms and recombines what's real." This function is plumbing for that pipeline,
// not a generative step itself.)
//
// verify_jwt=false (see supabase/config.toml [functions.brain]): Mosh has no per-user
// Supabase Auth, so there is no user JWT to verify. install_id is an OPAQUE per-install
// UUID (mosh::BrainProxy::installId() / brain_client._install_id() / vite.config.ts's
// installId() — all three converge on the same ~/Library/Mosh/<session>/identity.json
// "uuid" field) used ONLY for the daily token-cap bookkeeping below; it is never a
// secret and never an auth boundary. Anyone who can reach this URL and knows/guesses an
// install_id can spend that install's daily cap — the real backstops are the per-install
// cap itself, the best-effort IP rate limit, and the Supabase platform's own gateway
// limits, exactly the posture documented in functions/relay/index.ts.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const svc = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ── Providers (mirrors ui/vite.config.ts's moshiBrain + service/brain_client.py) ────
// Each is an OpenAI-compatible /chat/completions endpoint. Set via `supabase secrets
// set DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=... DEEPSEEK_MODEL=...` (per provider) —
// see the RUNBOOK. A provider only counts as configured once all three of its fields
// are present, same rule as BrainProxy::Provider::isComplete().
type Prov = { url?: string; key?: string; model?: string; label: string }
const PROVIDERS: Record<string, Prov> = {
  deepseek: { url: Deno.env.get('DEEPSEEK_BASE_URL'), key: Deno.env.get('DEEPSEEK_API_KEY'), model: Deno.env.get('DEEPSEEK_MODEL'), label: 'DEEPSEEK' },
  openai:   { url: Deno.env.get('OPENAI_BASE_URL'),   key: Deno.env.get('OPENAI_API_KEY'),   model: Deno.env.get('OPENAI_MODEL'),   label: 'OPENAI' },
  xai:      { url: Deno.env.get('XAI_BASE_URL'),      key: Deno.env.get('XAI_API_KEY'),      model: Deno.env.get('XAI_MODEL'),      label: 'GROK' },
}
const complete = (p?: Prov): p is Required<Prov> => !!(p && p.url && p.key && p.model)
// OpenAI reasoning models (gpt-5/6, o-series) reject `temperature` and use
// `max_completion_tokens` — mirrors BrainProxy.cpp's isReasoningModel / vite.config.ts.
const isReasoningModel = (model: string) => /^(gpt-5|gpt-6|o[0-9])/.test(model ?? '')

// requested → MOSHI_BRAIN_PROVIDER (a project secret, optional) → first complete —
// the exact chain BrainProxy::resolve() and brain_client.resolve() implement.
function resolveProvider(requested?: string): { id: string; p: Required<Prov> } | null {
  if (requested && complete(PROVIDERS[requested])) return { id: requested, p: PROVIDERS[requested] as Required<Prov> }
  const dflt = Deno.env.get('MOSHI_BRAIN_PROVIDER') ?? ''
  if (dflt && complete(PROVIDERS[dflt])) return { id: dflt, p: PROVIDERS[dflt] as Required<Prov> }
  for (const id of Object.keys(PROVIDERS)) { const p = PROVIDERS[id]; if (complete(p)) return { id, p: p as Required<Prov> } }
  return null
}

// ── Daily per-install token cap (see migrations/0003_brain_usage.sql) ───────────────
// A courtesy/cost-control ceiling, not adversarial-grade metering — this is a single-
// owner indie app, not a multi-tenant SaaS. Tune via secrets; see the RUNBOOK.
const DAILY_TOKEN_CAP = Number(Deno.env.get('BRAIN_DAILY_TOKEN_CAP') ?? 200_000)
// Pre-charged BEFORE the upstream call (see brain_usage_reserve's comment) and
// corrected to the real usage afterward (brain_usage_adjust) or refunded on failure.
const RESERVE_TOKENS = Number(Deno.env.get('BRAIN_RESERVE_TOKENS') ?? 1200)

// ── Abuse limits (best-effort; the platform is the real backstop) — same shape as
// functions/relay/index.ts's rateOk(), just keyed by IP instead of by mutation type. ──
const RATE_LIMIT = Number(Deno.env.get('BRAIN_RATE_LIMIT') ?? 60)
const RATE_WINDOW_MS = Number(Deno.env.get('BRAIN_RATE_WINDOW_MS') ?? 60_000)
const _hits = new Map<string, { start: number; n: number }>()
function rateOk(ip: string): boolean {
  if (RATE_LIMIT <= 0 || !ip) return true
  const now = Date.now()
  if (_hits.size > 4096)
    for (const [k, w] of _hits) if (now - w.start >= RATE_WINDOW_MS) _hits.delete(k)
  const w = _hits.get(ip)
  if (!w || now - w.start >= RATE_WINDOW_MS) { _hits.set(ip, { start: now, n: 1 }); return true }
  if (w.n >= RATE_LIMIT) return false
  w.n++; return true
}

const J = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } })

// install_id is opaque bookkeeping, not a credential — this is a SHAPE check (reject
// "unknown"/malformed ids gracefully with a clean 400), not a pre-registered allowlist.
// Accepts a bare juce::Uuid (32 hex, no dashes) or a dashed UUIDv4-style string.
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS' } })

  const url = new URL(req.url)
  if (url.pathname.endsWith('/health')) return J({ ok: true })
  if (req.method !== 'POST') return J({ error: 'POST only' }, 405)

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  if (!rateOk(ip)) return J({ error: 'rate_limited' }, 429)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return J({ error: 'invalid JSON body' }, 400) }

  const installId = typeof body.install_id === 'string' ? body.install_id : ''
  if (!installId || !INSTALL_ID_RE.test(installId))
    return J({ error: 'missing or malformed install_id' }, 400)

  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return J({ error: 'messages must be a non-empty array' }, 400)

  // `provider` is the canonical selector (matches the existing dev-proxy/native
  // contract); `model` is accepted as an alias per this function's documented request
  // shape ({messages, model?, install_id}) — `provider` wins if both are sent. Neither
  // is a raw model string handed to the upstream call: it only ever SELECTS which of
  // the three configured providers (each with its own fixed model secret) to use.
  const requested = typeof body.provider === 'string' ? body.provider
                   : typeof body.model === 'string' ? body.model
                   : undefined
  const chosen = resolveProvider(requested)
  if (!chosen) return J({ error: 'no brain provider configured (server-side secrets missing)' }, 503)
  const { id: providerId, p } = chosen

  const reserve = await svc.rpc('brain_usage_reserve', {
    p_install_id: installId, p_reserve_tokens: RESERVE_TOKENS, p_daily_cap: DAILY_TOKEN_CAP,
  })
  if (reserve.error) return J({ error: 'usage tracking unavailable' }, 500)
  if (reserve.data?.allowed === false)
    return J({ error: 'daily brain usage cap reached for this install', used: reserve.data.used, cap: reserve.data.cap }, 429)

  const isReasoning = providerId === 'openai' && isReasoningModel(p.model)
  const payload: Record<string, unknown> = { model: p.model, messages: body.messages, response_format: { type: 'json_object' } }
  if (isReasoning) payload.max_completion_tokens = 800
  else { payload.max_tokens = 800; payload.temperature = typeof body.temperature === 'number' ? body.temperature : 0.6 }

  // deno-lint-ignore no-explicit-any
  let j: any = {}
  let upstreamOk = false
  try {
    const upstream = await fetch(`${p.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(payload),
    })
    upstreamOk = upstream.ok
    j = await upstream.json().catch(() => ({}))
  } catch {
    // network failure reaching the provider — refund the reservation below, same as a
    // non-2xx response (neither burns the install's daily cap for a call that never
    // produced a completion).
  }

  // Correct the pre-charged estimate to the real cost. A call that never completed
  // (network error / non-2xx) is fully refunded (fallback 0). A call that DID
  // complete but whose response omitted `usage` (not all OpenAI-compatible providers
  // report it) keeps the original estimate rather than being refunded to free — under-
  // counting a real, billed call is the wrong direction to round for a spend cap.
  const actualTokens = Number(j?.usage?.total_tokens)
  const fallbackTokens = upstreamOk ? RESERVE_TOKENS : 0
  const delta = (Number.isFinite(actualTokens) ? actualTokens : fallbackTokens) - RESERVE_TOKENS
  await svc.rpc('brain_usage_adjust', { p_install_id: installId, p_delta_tokens: delta })

  if (!upstreamOk) return J({ ok: false, error: 'brain provider unreachable or errored' }, 502)

  // Deliberately minimal: the completion only. No provider id, no model, no upstream
  // error detail — those are internal to this function and never cross the boundary.
  return J({ ok: true, content: j.choices?.[0]?.message?.content ?? '' })
})
