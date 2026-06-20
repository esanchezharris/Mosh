// Mosh multiplayer relay — the cloud backend (Option A: all-Supabase).
//
// A thin Deno Edge Function that maps our exact /mp/* HTTP contract onto Postgres
// RPCs (public.mp_*). It preserves the request/response JSON our native
// MultiplayerClient already speaks, so the C++ client only changes its base URL +
// adds an `apikey` header. State + arbitration (seq, locks, epoch fencing) all live
// in one RPC == one transaction (see supabase/migrations/*), which keeps try_lock /
// publish race-free across concurrently-warm function instances.
//
// Deployed with verify_jwt = false: the room code (a ~128-bit bearer minted by
// mp_create_room) is the auth boundary, checked inside the RPCs — not Supabase Auth.
// The service-role key is auto-injected via Deno.env and never leaves the server.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const svc = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const J = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } })
const S = (v: unknown) => (typeof v === 'string' ? v : '')   // never pass undefined to an RPC arg

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' } })

  const url = new URL(req.url)
  const ep  = url.pathname.split('/').pop()   // create|join|publish|lock|unlock|leave|events|health
  if (ep === 'health') return J({ ok: true })

  let r: { data: any; error: any }
  try {
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
  } catch (e) {
    return J({ error: String(e) }, 400)
  }
  if (r.error) return J({ error: r.error.message }, 500)
  const hs = r.data?.http_status
  return J(r.data, typeof hs === 'number' ? hs : 200)   // map RPC http_status (409 fence / 410 dead room)
})
