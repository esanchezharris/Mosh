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

Presence is also reclaimed lazily by every room join/poll, so the UI does not wait for cron:
after 90 seconds without a heartbeat, the peer disappears from the roster, its locks are
released, and its room slot is free. The additive
`20260802080000_mp_peer_lease.sql` migration must be applied to an existing project.

`pg_cron` remains the bounded-growth backstop for rooms with no further traffic:
```sql
create extension if not exists pg_cron;
select cron.schedule('mp_sweep', '*/5 * * * *', $$ select mp.sweep(); $$);
```

## Cost

The relay is short-poll (the Edge Function returns immediately). The only lever is
the native poll cadence vs the Free-tier 500K invocations/month — keep the idle poll
interval at ~3–5s (back off when quiet) for casual sessions.

## Audio (P4 — done)

Private bucket `mp-stems`, content-addressed `<sha256>.<ext>` (`migrations/0002_mp_blob.sql`).
On commit, each wave clip's audio is hashed + consolidated into the edit's
`audio/by-hash/` (a relative ref both peers resolve), and the bytes are uploaded
via a **signed upload URL** minted by `/mp/blob/put-url`; the commit JSON carries
just the hashes. On apply, the receiver fetches any missing stems via a **signed
download URL** from `/mp/blob/get-url` into its own `audio/by-hash/`, so the
relative refs resolve. Both endpoints are gated on room membership (`mp_is_member`)
and the native client never holds the service-role key — the Edge Function mints
the signed URLs. `/mp/blob/head` is the dedup check (skip upload if already there).

Verified end to end over the internet by the gated `MOSH_SELFTEST_MP` selftest
against the cloud relay: a real WAV stem is hashed, uploaded, and fetched back by
a second peer (877/877). Per-file cap 50 MB (Free tier) — prefer FLAC/short stems.
