# Brain proxy — owner runbook

**What this closes:** the packaged app used to bundle `Contents/Resources/brain.env`
with real LLM provider keys (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`)
inside the `.app` — anyone who unzipped/inspected the bundle could extract a live key.
This is an **extractable-key ship-blocker**. The fix is the same shape as the existing
multiplayer relay (`supabase/functions/relay`): move the keys to a small server-side
proxy, and have the client call the proxy instead of a provider directly.

**Live deployment state is external to this repository.** Do not infer it from a
branch or an old PR description. Treat the backend as unverified until the owner
completes the smoke test in §5. The packaged app is proxy-only either way: without a
working `MOSH_BRAIN_PROXY_URL`, Moshi fails visibly and emits no edit commands.

---

## 1. What got built

| File | Role |
|---|---|
| `supabase/functions/brain/index.ts` | The Edge Function. Accepts `{messages, model?/provider?, install_id}`, holds provider keys as Supabase secrets, proxies to deepseek→openai→xai (same chain + reasoning-model handling as today), enforces a per-install daily token cap, returns only `{ok, content}` — never a key, never which provider served it. |
| `supabase/migrations/0003_brain_usage.sql` | The daily-cap table (`public.brain_usage_daily`) + two SECURITY DEFINER RPCs (`brain_usage_reserve` / `brain_usage_adjust`) the function calls as `service_role`. Verify applied state before deployment; see step 3. |
| `supabase/config.toml` | Added `[functions.brain]` with `verify_jwt = false` (mirrors `[functions.relay]` — Mosh has no per-user Supabase Auth). |
| `src/brain/BrainProxy.{h,cpp}` | Native path. `chat()` prefers the proxy when `MOSH_BRAIN_PROXY_URL` is set; direct-provider environment configuration remains available for local development, but packaging never copies those secrets. |
| `ui/vite.config.ts` | Dev server's `/api/brain/chat` middleware gets the same proxy-first-then-fallthrough branch, gated on `MOSH_BRAIN_PROXY_URL` in `ui/.env.local`. |
| `service/brain_client.py` | Same proxy-first-then-fallthrough branch for the Python sidecar (used by the lyric-generation loop and the prompt-compiler). |
| `docs/brain-proxy/RUNBOOK.md` | This file. |

All three client entry points retain process-local direct-provider configuration for
development. Distribution is a stricter boundary: macOS release/deploy, Windows
packaging, and the guest ZIP refuse provider API keys and write only the proxy URL and
publishable proxy credential.

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

Check the linked project before assuming this migration is applied. Review
`supabase/migrations/0003_brain_usage.sql`, then:

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
(useful for testing/CI — see the gate section below). With no session override, the
owner identity is used. An explicit override may persist identity only in an exact
marker-owned `_harness` leaf; the packaged engine can claim a newly-created empty leaf
before the sidecars start. Unsafe, escaping, symlinked, or unowned values use a
per-process safety/ephemeral identity and never mutate the real
`~/Library/Mosh/session/identity.json`.

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

Each entry point is gated on `MOSH_BRAIN_PROXY_URL`. Local development may fall back
to direct environment configuration; distributable artifacts contain no provider
secret and therefore fail visibly if the proxy is unavailable.

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

Both `run-mosh.sh` and `run-mosh.ps1` now bundle `MOSH_BRAIN_PROXY_URL` and
`MOSH_BRAIN_PROXY_APIKEY`; `service/scripts/bundle_completeness_test.py` keeps their
brain-configuration key lists identical. A proxy-only `ui/.env.local` therefore
survives a Dock/Finder launch on macOS and a double-click launch on Windows without
putting any provider key in the package.

The packaged app's `brain.env` contains only the proxy URL and publishable proxy
credential. If any direct-provider `*_API_KEY` is present in the source dotenv,
release and guest packaging stop before producing an artifact.

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

- Don't restore direct-provider fields to `brain.env`; direct configuration is local
  development only.
- Don't put a real provider key in `MOSH_BRAIN_PROXY_APIKEY` — that variable is the
  Supabase **publishable** key (safe to embed; it's a client key), not a provider
  secret. Provider secrets only ever go through `supabase secrets set`.
- Don't skip the shape review of `0003_brain_usage.sql` before running `supabase db
  push` — apply it deliberately, the same way you'd review any other migration.

## House principle

Everything starts from something real of yours. This proxy is plumbing around the
existing brain chat path; it changes key custody and spend limits, not what gets
generated.
