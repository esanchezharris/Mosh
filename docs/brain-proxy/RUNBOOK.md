# Brain proxy — owner runbook

**What this closes:** the packaged app used to bundle `Contents/Resources/brain.env`
with real LLM provider keys (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`)
inside the `.app` — anyone who unzipped/inspected the bundle could extract a live key.
This is an **extractable-key ship-blocker**. The fix is the same shape as the existing
multiplayer relay (`supabase/functions/relay`): move the keys to a small server-side
proxy, and have the client call the proxy instead of a provider directly.

**Scaffolded, not deployed.** Nothing in this change deploys real infrastructure or
sets a real secret — that is deliberately left to you (the owner), below. Until you
complete the deploy + cutover steps, the app behaves EXACTLY as it does today (bundled
keys, direct provider calls) — the whole proxy path is inert until `MOSH_BRAIN_PROXY_URL`
is set somewhere.

---

## 1. What got built

| File | Role |
|---|---|
| `supabase/functions/brain/index.ts` | The Edge Function. Accepts `{messages, model?/provider?, install_id}`, holds provider keys as Supabase secrets, proxies to deepseek→openai→xai (same chain + reasoning-model handling as today), enforces a per-install daily token cap, returns only `{ok, content}` — never a key, never which provider served it. |
| `supabase/migrations/0003_brain_usage.sql` | The daily-cap table (`public.brain_usage_daily`) + two SECURITY DEFINER RPCs (`brain_usage_reserve` / `brain_usage_adjust`) the function calls as `service_role`. **Not applied anywhere yet** — see step 3. |
| `supabase/config.toml` | Added `[functions.brain]` with `verify_jwt = false` (mirrors `[functions.relay]` — Mosh has no per-user Supabase Auth). |
| `src/brain/BrainProxy.{h,cpp}` | Native packaged-app path. New `proxyEnabled()` / `proxyUrl()` / `installId()`; `chat()` tries the proxy first when `MOSH_BRAIN_PROXY_URL` is set, and falls through to the existing bundled-key path on any proxy failure. |
| `ui/vite.config.ts` | Dev server's `/api/brain/chat` middleware gets the same proxy-first-then-fallthrough branch, gated on `MOSH_BRAIN_PROXY_URL` in `ui/.env.local`. |
| `service/brain_client.py` | Same proxy-first-then-fallthrough branch for the Python sidecar (used by the lyric-generation loop and the prompt-compiler). |
| `docs/brain-proxy/RUNBOOK.md` | This file. |

**Additive by design:** all three client entry points keep their existing
bundled-key / local-`.env`-key path as the fallback. If the proxy URL is unset, or the
proxy is unreachable, or it errors, the client falls through to the pre-existing
behavior. Nothing breaks mid-migration, and you can flip the cutover independently on
each platform (see step 5).

---

## 2. Deploy the function

```sh
cd supabase   # or wherever your linked Supabase project root is
supabase link --project-ref tpvkqaqydafpgockzchm     # the same project the relay lives in

# Provider keys — set whichever provider(s) you want the proxy to use. At least one
# provider needs all three of its fields for the function to resolve anything.
supabase secrets set \
  DEEPSEEK_BASE_URL=https://api.deepseek.com \
  DEEPSEEK_API_KEY=sk-... \
  DEEPSEEK_MODEL=deepseek-chat \
  OPENAI_BASE_URL=https://api.openai.com/v1 \
  OPENAI_API_KEY=sk-... \
  OPENAI_MODEL=gpt-5.4-mini \
  XAI_BASE_URL=https://api.x.ai/v1 \
  XAI_API_KEY=xai-... \
  XAI_MODEL=grok-4 \
  MOSHI_BRAIN_PROVIDER=deepseek          # optional: pin the default (else first-complete)

# Optional cap tuning (defaults: 200,000 tokens/day per install; a 1,200-token
# pre-charge reserved before each call, corrected to the real usage after).
supabase secrets set BRAIN_DAILY_TOKEN_CAP=200000 BRAIN_RESERVE_TOKENS=1200

supabase functions deploy brain
```

`supabase secrets set` is **project-wide** (shared with `relay`), so if `relay` already
has, say, an unrelated secret set, this won't touch it — secrets are additive by key
name. Never commit real values; the commands above are templates, not a `.env` file to
check in.

The deploy prints the function URL — it will be
`https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/brain` (same project, same
shape as the relay's `.../functions/v1/relay`).

You don't need to redeploy after changing secrets (`supabase secrets set` takes effect
immediately); you DO need to redeploy after editing `index.ts`.

---

## 3. Apply the daily-cap migration

**This was intentionally NOT run for you.** Review `supabase/migrations/0003_brain_usage.sql`
first, then:

```sh
supabase db push               # applies every not-yet-applied migration under supabase/migrations/
# or, to apply just this one via the dashboard's SQL editor, paste the file's contents.
```

This creates `public.brain_usage_daily` (RLS enabled, no policies — deny-all via
PostgREST, exactly like `mp.rooms`/`mp.peers` in `0001_mp_relay.sql`) plus the two RPCs
the function calls as `service_role`. Nothing in the app can read/write this table
directly; only the Edge Function can, via `service_role`-only `GRANT EXECUTE`.

**Optional GC:** the cap only needs a few days of history. Either run
`select public.brain_usage_prune();` occasionally, or schedule it exactly like the
relay's `mp.sweep()` (see `supabase/README.md`'s GC section):

```sql
select cron.schedule('brain_usage_prune', '0 4 * * *', $$ select public.brain_usage_prune(); $$);
```

---

## 4. The install-id scheme

`install_id` is an **opaque per-install UUID** — never a secret, never an auth
boundary (there is no Supabase Auth in Mosh; `verify_jwt=false` on this function is
correct and intentional, same as `relay`). It exists purely so the daily cap is
per-install rather than a single global bucket.

All three client entry points resolve the SAME id, converging on one file:

- **Native (packaged app):** `mosh::BrainProxy::installId()` reads/mints
  `~/Library/Mosh/session/identity.json`'s `"uuid"` field (the same app-data root
  `MoshEngine` uses).
- **Dev server:** `ui/vite.config.ts`'s `installId()` reads/mints the same file.
- **Python sidecar:** `service/brain_client.py`'s `_install_id()` reads/mints the same
  file.

Whichever of the three runs first on a machine mints the UUID and persists it; the
others then read and reuse it. `MOSH_BRAIN_INSTALL_ID` overrides all three outright
(useful for testing/CI — see the gate section below); `MOSH_SELFTEST_SESSION` picks an
isolated leaf directory, mirroring `MoshEngine`'s own harness-isolation convention, so
automated runs never touch or mutate your real `~/Library/Mosh/session/identity.json`.

`identity.json` already existed on this machine with a `uuid` field (pre-dating this
change — apparently seeded ahead of the still-unbuilt FS-K3 crash-reporting consent
lane, see `docs/first-stranger-program/lanes/fs-k3.md`). The brain proxy is simply the
first consumer to actually READ that field; it only ever reads/adds `"uuid"` and never
touches `"consent"` or any other key that file may carry.

The Edge Function does a **shape check only** (`/^[a-zA-Z0-9_-]{8,128}$/`) — it rejects
a missing/malformed `install_id` with a clean `400`, but there is no pre-registration
step or allowlist. Anyone who can reach the URL and knows/guesses an id can spend that
id's daily cap; the real backstops are the cap itself, the best-effort per-IP rate
limit in `index.ts`, and the Supabase platform's own gateway limits — the same posture
already documented and shipped for the multiplayer relay.

---

## 5. Flip the app to proxy mode

Each of the three entry points is independently gated on `MOSH_BRAIN_PROXY_URL` being
set (falling through to the old direct path if it's ever unreachable), so you can turn
this on incrementally and verify each before moving on.

**Dev (Vite):** add to `ui/.env.local`:
```
MOSH_BRAIN_PROXY_URL=https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/brain
MOSH_BRAIN_PROXY_APIKEY=<the project's publishable/anon key — the SAME non-secret
                          value already baked into src/multiplayer/MultiplayerClient.cpp
                          as kCloudRelayApiKey, since it's the same Supabase project>
```
Restart `npm run dev`; the existing brain UI now round-trips through the deployed
function. Confirm with the network tab that `/api/brain/chat` responses no longer
carry a `model` field and that no request ever leaves the browser with a provider key
in it (it never did — the dev proxy already kept keys server-side; this just moves
"server-side" from your laptop's Vite process to Supabase).

**Python sidecar:** export the same two vars (or add them to whichever `.env` the
service reads, e.g. next to the feature venvs' `.env` files) before starting
`service/server.py`.

**Packaged app — this is the part that actually closes the ship-blocker.**

`BrainProxy::env()` checks the real process environment before it ever falls back to
reading bundled `brain.env`, so exporting the two vars in the shell that runs
`run-mosh.sh deploy`/`deploy-anira` is enough for **that build to work while the
machine that built it stays up** (a shell-launched `Mosh` binary, or a Dock/Finder
launch happening in the same login session that still has the export). That's fine
for verifying the cutover end to end, but it is not durable: a later Dock/Finder
launch in a fresh session inherits no shell env at all — same reason `bundle_brain_key()`
exists in the first place (see its comment in `run-mosh.sh`, "a Finder/Dock
double-click ... inherits NO shell env").

**Known gap — a small follow-up outside this change's scope:** `run-mosh.sh`'s
`bundle_brain_key()` (around line 213) writes `Contents/Resources/brain.env` from a
**hardcoded whitelist** of var names (`MOSHI_BRAIN_PROVIDER`, `OPENAI_*`,
`DEEPSEEK_*`, `XAI_*`) — it does not yet know about `MOSH_BRAIN_PROXY_URL` /
`MOSH_BRAIN_PROXY_APIKEY`, so a plain `run-mosh.sh deploy` today will NOT bundle them
even if they're in `ui/.env.local`. `run-mosh.sh` was deliberately left untouched by
this change (it's outside this workstream's file allowlist). Closing the loop for a
Dock-launch-durable proxy-only bundle needs one small edit: add
`MOSH_BRAIN_PROXY_URL` and `MOSH_BRAIN_PROXY_APIKEY` to the `for v in ...` list in
`bundle_brain_key()`. Until that lands, the bundled `brain.env` keeps shipping the
four provider secrets (today's status quo, not a regression from this change) —
proxy mode still works for any launch that inherits the shell export, which is
sufficient to verify the whole path before doing that follow-up.

Once `bundle_brain_key()` carries the two proxy vars (that follow-up) and you
confirm the proxy path end to end:

> **The packaged app's `brain.env` no longer needs to contain a single provider key.**
> `BrainProxy::chat()` tries the proxy first; provider keys live only in Supabase
> secrets, server-side, never inside anything you ship. Once you've confirmed the
> proxy path works end to end (`--brain-smoke` below, or the in-app brain UI), you can
> delete the four `<PROVIDER>_*` lines from the `brain.env` your deploy script writes
> — a build that ships without them is the actual fix landing.

Smoke it from the built app:
```sh
MOSH_BRAIN_SMOKE_PROMPT="Say hi in one line" \
MOSH_BRAIN_PROXY_URL=https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/brain \
MOSH_BRAIN_PROXY_APIKEY=<publishable key> \
  ./build/.../Mosh --brain-smoke
```
`BrainProxy::resolve()` in the smoke output reflects the DIRECT-provider chain (it's a
diagnostic for that path specifically); a successful proxied reply is what to look for
in the `OK [...] content: ...` line — `provider=proxy` in a future diagnostic surface
would need `providersInfo()` extended for that, which this change does not do (kept
minimal; `providersInfo()` is unchanged and still describes only the direct-provider
chain, which is fine since it is diagnostic-only, not read by proxy-mode logic).

---

## 6. What NOT to do

- Don't remove the direct-provider path from any of the three files. It is the
  documented fallback (proxy unset/unreachable) and is what keeps local dev working
  without a deployed function.
- Don't put a real provider key in `MOSH_BRAIN_PROXY_APIKEY` — that variable is the
  Supabase **publishable** key (safe to embed; it's a client key), not a provider
  secret. Provider secrets only ever go through `supabase secrets set`.
- Don't skip the shape review of `0003_brain_usage.sql` before running `supabase db
  push` — apply it deliberately, the same way you'd review any other migration.

## House principle

Mosh doesn't invent — it transforms and recombines what's real. This proxy is
plumbing (key custody + a spend cap) around the existing brain chat path; it does not
change what gets generated or how.
