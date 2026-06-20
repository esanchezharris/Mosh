# Mosh multiplayer — Supabase cloud backend (Option A)

The cloud relay that lets two remote peers collaborate over the internet. It is the
**same relay contract** as the local self-host relay (`relay/`), just hosted in
Supabase so it's internet-reachable and shares one place with audio storage.

- **`migrations/0001_mp_relay.sql`** — the Postgres port of `relay/room.py`: private
  `mp.*` tables + `public.mp_*` SECURITY-DEFINER RPCs (race-free lock/publish, epoch
  fencing, per-room seq, no-echo poll). Apply with the Supabase CLI/connector.
- **`functions/relay/index.ts`** — a thin Edge Function mapping `/mp/*` → the RPCs,
  preserving the exact JSON our native `MultiplayerClient` speaks. `verify_jwt=false`
  (the room code is the bearer; auth is in the RPCs).

## The two backends, one binary

`Mosh` targets either backend purely via env — no rebuild, no code branch:

| | URL | apikey |
|---|---|---|
| **Local (dev / CI)** | `http://127.0.0.1:8771` (default) — `python3 relay/server.py` | none (the local relay ignores the header) |
| **Cloud (internet)** | `https://<ref>.supabase.co/functions/v1/relay` | the project **publishable** key |

```sh
# Cloud:
export MOSH_RELAY_URL="https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/relay"
export MOSH_RELAY_APIKEY="sb_publishable_…"     # publishable = safe to embed/share
```

The native delta to support both is two lines in `src/multiplayer/MultiplayerClient.cpp`
(a base URL + an `apikey` header from `MOSH_RELAY_APIKEY`).

## Keys & secrets

| Value | Embed in client? | Where |
|---|---|---|
| Project URL | n/a (public) | `…supabase.co` |
| Publishable key (`sb_publishable_…`) | **YES** | `MOSH_RELAY_APIKEY` |
| **Service-role key** | **NO — never in the client/WebView** | auto-injected into the Edge Function via `Deno.env`; set in the Python service env as `SUPABASE_SERVICE_ROLE_KEY` for stem uploads (P4). The user sets this from the dashboard; it is never pasted into chat or committed. |

## GC (optional)

Bounded growth via `pg_cron`:
```sql
create extension if not exists pg_cron;
select cron.schedule('mp_sweep', '*/5 * * * *', $$ select mp.sweep(); $$);
```

## Cost

The relay is short-poll (the Edge Function returns immediately). The only lever is
the native poll cadence vs the Free-tier 500K invocations/month — keep the idle poll
interval at ~3–5s (back off when quiet) for casual sessions.

## Audio (P4 — not yet wired)

Private bucket `mp-stems`, content-addressed `<sha256>.<ext>`. The Python service
uploads with the service-role key; the receiver gets a signed download URL minted by
a `/mp/blob/get-url` endpoint (gated on room membership), bare-GETs it, and the
existing `clip.sourceMissing` → `relink_clip` path lands the file.
