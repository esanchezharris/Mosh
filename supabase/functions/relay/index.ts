// Mosh multiplayer relay — the cloud backend (Option A: all-Supabase).
//
// A thin Deno Edge Function that (1) maps our exact /mp/* HTTP contract onto
// Postgres RPCs (public.mp_*), preserving the JSON our native MultiplayerClient
// already speaks, and (2) mints membership-gated SIGNED Storage URLs for audio
// stems (P4) so the native client uploads/fetches by content hash without ever
// holding the service-role key.
//
// verify_jwt=false: the room code (a ~128-bit bearer minted by mp_create_room) is
// the auth boundary, checked in the RPCs / via mp_is_member — not Supabase Auth.
// State + arbitration (seq, locks, epoch fencing) is one-RPC-one-transaction.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const svc = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const BUCKET = 'mp-stems'

const J = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } })
const S = (v: unknown) => (typeof v === 'string' ? v : '')
const keyFor = (hash: string, ext: string) => `${hash}.${(ext || 'wav').replace(/[^a-z0-9]/gi, '')}`
async function member(code: string, peer: string): Promise<boolean> {
  const r = await svc.rpc('mp_is_member', { p_code: code, p_peer: peer })
  return r.data === true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' } })

  const url = new URL(req.url)
  const ep  = url.pathname.split('/').pop()
  if (ep === 'health') return J({ ok: true })

  try {
    // ---- audio blob (signed URLs, membership-gated) ----
    if (ep === 'put-url' || ep === 'get-url' || ep === 'head') {
      const b = await req.json()
      if (!(await member(S(b.code), S(b.peerId)))) return J({ error: 'not_a_member' }, 403)
      const key = keyFor(S(b.hash), S(b.ext))
      if (ep === 'head') {
        const { data } = await svc.storage.from(BUCKET).list('', { search: key, limit: 1 })
        return J({ exists: !!data?.some((o) => o.name === key) })
      }
      if (ep === 'put-url') {
        const { data, error } = await svc.storage.from(BUCKET).createSignedUploadUrl(key)
        if (error) return J({ error: error.message }, 500)
        return J({ url: data.signedUrl, token: data.token, path: data.path })
      }
      // get-url
      const { data, error } = await svc.storage.from(BUCKET).createSignedUrl(key, 3600)
      if (error) return J({ error: error.message }, 404)
      return J({ url: data.signedUrl })
    }

    // ---- relay control plane (RPCs) ----
    let r: { data: any; error: any }
    if (ep === 'events') {
      const q = url.searchParams
      r = await svc.rpc('mp_events',
        { p_code: q.get('code'), p_peer: q.get('peerId'), p_since: Number(q.get('since') ?? 0) })
    } else {
      const b = await req.json()
      switch (ep) {
        case 'create':  r = await svc.rpc('mp_create_room', { p_peer: S(b.peerId), p_name: S(b.name), p_color: S(b.color) }); break
        case 'join':    r = await svc.rpc('mp_join_room',  { p_code: S(b.code), p_peer: S(b.peerId), p_name: S(b.name), p_color: S(b.color) }); break
        case 'publish': r = await svc.rpc('mp_publish',    { p_code: S(b.code), p_peer: S(b.peerId), p_msg: b.msg ?? {} }); break
        case 'lock':    r = await svc.rpc('mp_try_lock',   { p_code: S(b.code), p_peer: S(b.peerId), p_key: S(b.key), p_steal: b.steal ?? false }); break
        case 'unlock':  r = await svc.rpc('mp_unlock',     { p_code: S(b.code), p_peer: S(b.peerId), p_key: S(b.key) }); break
        case 'leave':   r = await svc.rpc('mp_leave',      { p_code: S(b.code), p_peer: S(b.peerId) }); break
        default: return J({ error: 'not_found' }, 404)
      }
    }
    if (r.error) return J({ error: r.error.message }, 500)
    const hs = r.data?.http_status
    return J(r.data, typeof hs === 'number' ? hs : 200)   // map RPC http_status (409 fence / 410 dead room)
  } catch (e) {
    return J({ error: String(e) }, 400)
  }
})
