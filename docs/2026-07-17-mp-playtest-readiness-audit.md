# MP playtest-readiness audit — 2026-07-17

*Read-only audit of the multiplayer stack ahead of a reliable remote two-Mac playtest. Branch
`claude/burn-mp-audit`, forked from `origin/main` at `1044a51b`. No MP code, relay, RPCs, or
parked branches were modified — this doc is the deliverable.*

> **Historical context (superseded 2026-08-23):** The First-Stranger Program is paused and its
> record lives at `docs/archive/first-stranger-program-2026-08-23/`. Any lanes, owner tasks, or
> proposed scale work cited below describe this July audit's context only; they are not active
> commitments or a current serving policy.

## TL;DR verdict

| # | Question | Verdict | One-liner |
|---|---|---|---|
| 1 | True gap to a reliable 2-Mac session | **READY** | Full round trip traced + reproduced live over the real cloud relay this session (PASS). Remaining friction is known, documented, and guidance-mitigated, not code-broken. |
| 2 | Content-addressed storage: Supabase Storage vs R2 | **DECISION** | Supabase Storage is done, self-healing, and proven live. R2 appeared only in a different program record that is now archived — defer it for this audit. |
| 3 | `mp_events` long-poll vs Supabase Realtime | **DECISION** | Current 250ms short-poll is sufficient for a 2-peer session. Defer Realtime. |
| 4 | bounce-on-commit correctness + the relative-ref export hang | **READY** | No literal "bounce" happens (MIDI syncs as data, not audio — a scope correction, not a bug). The historical export hang is confirmed fixed and shared across all 3 source-repoint call sites on current `main`. |
| 5 | Schema versioning covers MP fields | **READY** | One global format version (`kMoshFormatVersion=1`) covers MP's only persisted field (`moshLogicalId`); everything else (locks/presence) is relay-side and never touches the file. |
| 6 | Hermetic MP test coverage | **READY** | Reproduced independently: relay pytest 58/58, `--selftest` 1306/1306 (baseline), MP selftest 1400/1400 ×4/5 runs (1 explained flake under measured extreme load), plus a **fresh, first-party live two-process cloud PASS** run by this audit. |
| 7 | Parked branches (#354/#349/#353) | **READY** | All three are **already merged to `main`** (verified via `git merge-base` + `gh pr view`). The task brief's "parked/open" framing is stale — it mirrors `CLAUDE.md`'s mid-session working notes, which this audit found out of date. |

**Bottom line:** the MP stack is materially more done than "scaffold," and today's own evidence (a live two-OS-process round trip over the production cloud relay, run twice by the team earlier and once more by this audit) says the wiring works. Nothing found here should block starting tonight's/this playtest. The one irreducible unknown — two real humans on two real Macs, live — needs the owner, not more code review.

---

## 1. Architecture map

```
       Mac A (host)                                    Mac B (guest)
   ┌────────────────────┐                          ┌────────────────────┐
   │ Mosh.app            │                          │ Mosh.app            │
   │ MultiplayerClient    │  HTTPS POST/GET          │ MultiplayerClient    │
   │ MultiplayerSession    │  (outbound only,        │ MultiplayerSession    │
   │  poll loop (250ms)     │   both directions)     │  poll loop (250ms)     │
   │  TransferQueue           │                      │  TransferQueue           │
   └───────────┬──────────────┘                      └──────────────┬──────────┘
               │                                                     │
               └──────────────────────┬──────────────────────────────┘
                                       │  both peers dial OUT only
                                       ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  Supabase project  (tpvkqaqydafpgockzchm)                                 │
   │  Edge Function `relay` (Deno, verify_jwt=false — room code is the auth)   │
   │    -> SECURITY DEFINER RPCs `public.mp_*` (service_role-only)             │
   │    -> schema `mp` (private, RLS-denied): rooms / peers / messages / locks │
   │    -> Storage bucket `mp-stems` (private, 50MB/file cap, content-addr'd)  │
   └─────────────────────────────────────────────────────────────────────────┘
```

**Control plane** — `supabase/functions/relay/index.ts` (121 lines) is a thin Deno edge
function mapping `/mp/{create,join,publish,lock,unlock,leave,events}` onto Postgres RPCs
(`index.ts:106-113`). `verify_jwt=false`; the ~128-bit room code (`mp.gen_code()`,
`supabase/migrations/0001_mp_relay.sql:57-60`, via `pgcrypto`) is the real auth boundary, not
Supabase Auth (`index.ts:9-10`). Abuse limits are best-effort (per-isolate in-memory rate
limit 600 req/60s, 8MB body cap, `/mp/events` exempted — `index.ts:20-43,65-72`); the deny-all
RLS + 24h room expiry + platform gateway are the real backstop (`index.ts:24-29`).

**Data plane (audio)** — `/mp/blob/{head,put-url,get-url}` (`index.ts:78-95`) mint
membership-gated signed Storage URLs (`mp_is_member`, `supabase/migrations/0002_mp_blob.sql:9-18`)
so the native client PUTs/GETs bytes directly to/from Storage, never through the control-plane
function. Bucket `mp-stems`: private, 50MB/file (`supabase/migrations/0002_mp_blob.sql:4-6`).

**Native side** — `src/multiplayer/MultiplayerClient.{h,cpp}` (transport-only HTTP client,
430+126 lines), `MultiplayerSession.{h,cpp}` (session lifecycle, poll loop, `TransferQueue`
worker, 548+225 lines), `LockManager.{h,cpp}` (sync/local command classification, 113+lines),
`LogicalId.h` (cross-peer stable track identity), `TrackCommit.{h,cpp}` (track-subtree
serialize/apply). MoshOps command dispatch: `src/moshops/MoshOps.cpp:1018-1029`
(`mp_sync_locks`, `mp_create_session`, `mp_join_session`, `mp_leave_session`,
`mp_claim_track`, `mp_commit_track`, `mp_broadcast_selection`, `mp_send_signal`,
`mp_serialize_project`, `mp_apply_bootstrap`, `mp_fetch_missing_stems`, `mp_apply_structural`).
None of these are agent-callable (`docs/02_MOSHOPS_CONTRACT.md:62` — deliberately
backend/human-only).

**UI side** — commit-on-move derivation is pure and unit-tested in
`ui/src/multiplayer/sync.ts` (`deriveActiveTrackId`/`computeSyncActions`/`lockOwnerOfTrack`/
`pruneOfflineLocks`); wired into the store's `syncActiveTrack` (`ui/src/store.ts:737-776`).
Session UI: `ui/src/ui/MultiplayerPanel.tsx` (classic shell) / `ui/src/v2/MultiplayerLauncher.tsx`
(v2 shell, PR #350's Create/Join redesign).

---

## 2. Per-question findings

### Q1 — True gap to a reliable 2-Mac remote session — **READY**

**Full round trip, traced with citations:**

1. **Create/join.** `mp_create_room`/`mp_join_room` (`supabase/migrations/0001_mp_relay.sql:73-109`)
   — a 2-person `member_cap` (`:22`), 24h room expiry refreshed on join (`:104`).
2. **Poll loop starts** the instant a session is created/joined
   (`MultiplayerSession.cpp:41-68`), on a **dedicated background thread**
   (`startPoll`/`pollLoop`, `MultiplayerSession.cpp:333-346`) at a **~250ms cadence**
   (`MultiplayerSession.cpp:542-544`) — `mp_events` itself is a plain, immediately-returning
   Postgres query, not a blocking wait (see Q3).
3. **A mutation** is classified by `LockManager::classify()` (`src/multiplayer/LockManager.cpp:13-92`)
   into Unguarded / Track / Clip / SessionGlobal (fail-closed default for anything unlisted,
   `:88-91`).
4. **Commit-on-move**: `ui/src/multiplayer/sync.ts:33` (`computeSyncActions`) fires when the
   actively-edited track changes (`ui/src/store.ts:737-776`) — releases+commits the old track,
   claims the new one. `mp_claim_track` → `POST /mp/lock` → `mp_try_lock`
   (`supabase/migrations/0001_mp_relay.sql:143-160`) mints a monotonic epoch fencing token and
   a **90-second lease**.
5. **`mp_commit_track`** (`src/moshops/MoshOps.cpp:2946-3005`) content-addresses the track's
   wave clips into `audio/by-hash/<sha256>.<ext>` and returns **immediately**
   (`status:"uploading"`); the actual upload + `mp_publish` + lock release run on a dedicated
   `TransferQueue` worker thread (`MultiplayerSession.cpp:176-266`) — never the message thread,
   never the poll thread (see PR #354 in §4 below). `mp_publish`
   (`supabase/migrations/0001_mp_relay.sql:112-141`) is **epoch-fenced**: a commit whose epoch
   is stale returns **HTTP 409** (`:133-135`), surfaced by `index.ts:117`.
6. **The peer's poll loop** picks up the `"commit"` frame, downloads any referenced stem
   (SHA-256-verified on arrival, `MultiplayerClient.cpp:388-405`), then applies the track's XML
   blob (`TrackCommit::apply`, `src/multiplayer/TrackCommit.cpp:19-40`+).
7. **Late joiner (bootstrap):** `joinSession` auto-fires a `bootstrap_request`
   (`MultiplayerSession.cpp:62-67`); the host serializes the whole project
   (`contentAddressWholeProjectNoUpload`, `MoshOps.cpp:3056+`), the worker uploads every stem
   then publishes `bootstrap_state`; the joiner applies it
   (`cmdMpApplyBootstrap`, `MoshOps.cpp:3154-3222`) and **automatically** fires the self-heal
   pass (`cmdMpFetchMissingStems`, `MoshOps.cpp:3217,3224-3286+`) so a transient miss doesn't
   need a manual nudge.

**Failure modes for two Macs on different networks, assessed:**

- **NAT/firewall — a non-issue by design.** Every leg of the core sync (control plane AND the
  blob PUT/GET) is client-initiated **outbound** HTTPS from both peers to one public cloud
  endpoint (`MultiplayerClient.cpp` uses `juce::URL` POST/GET exclusively). No inbound ports,
  no port-forwarding, no STUN/TURN needed for the part that actually matters (project state +
  audio stems). This is a genuine architectural strength for a "two home networks" playtest.
- **Latency/timeouts.** Control-plane calls (create/join/publish/lock/poll) use a 5000ms
  connection timeout (`MultiplayerClient.cpp:60,73,167`); blob PUT/GET use 60000ms
  (`MultiplayerClient.cpp:292,341`). **No automatic retry** on a timed-out control-plane call —
  confirmed by reading `publish()`/`tryLock()`/`poll()` (no retry loop anywhere in
  `MultiplayerClient.cpp`). This matches the team's own documented limit: "a network drop can
  be invisible... edits sent during the outage are silently dropped rather than
  queued/retried" (`docs/playtest-prep/KNOWN_LIMITS_v0.md:40-43`; independently confirmed by
  reading `pollLoop()`, `MultiplayerSession.cpp:348-546` — it emits `mp_state{active:true}`
  unconditionally every tick regardless of whether the underlying `client_.poll()` succeeded).
  Guidance already documented: "if edits stop showing up on the other Mac, both of you leave
  and rejoin."
- **Signed-URL expiry.** `get-url` mints a **1-hour** signed URL (`index.ts:92`,
  `createSignedUrl(key, 3600)`) — the client fetches immediately after minting it, so this is
  not a practical playtest risk.
- **Missing-stem self-heal.** Covered above — automatic post-bootstrap, SHA-256-verified,
  manually retriable.
- **Two gaps found by this audit, both already known/triaged by the team** (see the
  prioritized list in §3): the lock-lease has no renewal mechanism, and the "idle checkpoint"
  documented in `docs/MULTIPLAYER.md:51` does not actually exist in code.

### Q2 — Is content-addressed take storage DONE? Supabase Storage vs R2 — **DECISION: Supabase Storage is sufficient; defer R2**

**What's shipped, today, on `main`:** a private, content-addressed Storage bucket `mp-stems`
(`supabase/migrations/0002_mp_blob.sql:4-6`), gated by `mp_is_member`
(`supabase/migrations/0002_mp_blob.sql:9-18`), reached only via short-lived signed URLs
(`index.ts:86-94`). Self-healing (PR #347, merged — see Q7): `mp_fetch_missing_stems`
re-derives a missing hash/ext from the clip's own by-hash path and retries; every download is
SHA-256-verified before being accepted (`MultiplayerClient.cpp:388-405`). **This is done, and
it is proven working live** — see the fresh two-process cloud PASS in §Q6 below (this audit's
own run, today).

**Where the "R2" ask actually comes from:** it is **not** a documented gap in *this* MP system
— it was the storage plan for a **different, larger program that was then unstarted and is now
archived**: `docs/archive/first-stranger-program-2026-08-23/SPEC.md:46-49` ("Take storage =
Cloudflare R2, content-addressed ... Supabase Storage is not used for takes"), staged at the time
as former lane **FS-S1**, gated on `FS-T3, FS-S0, O4` — with `O4` ("Cloudflare account + R2 bucket")
then an **unprovisioned account/infra prerequisite**
(`docs/archive/first-stranger-program-2026-08-23/STATUS.md:37,51`). That archived program's
stated reasoning for R2 (`docs/archive/first-stranger-program-2026-08-23/SPEC.md:324-326`) is
**egress cost at fan-out scale** ("Supabase Storage egress ($0.09/GB) makes it wrong for
fan-out") — a concern that doesn't bite at n=2 peers and a handful of takes.

**Decision:** adopting R2 now would mean standing up brand-new, unprovisioned infrastructure to
solve a cost/scale problem this playtest doesn't have, in place of a storage path that already
passes a live cross-process cloud test today. **Defer R2 for this audit; no successor work is
implied by the archived lanes.** One real, worth-tracking risk that *is* specific to the current
mechanism (not a reason to jump to R2, but worth a cheap owner check) — see blocker #2 in §3:
large-stem upload reliability is untested at realistic take sizes.

### Q3 — `mp_events` long-poll vs Supabase Realtime — **DECISION: current short-poll is sufficient for a 2-peer playtest; defer Realtime**

`mp_events` (`supabase/migrations/0001_mp_relay.sql:182-198`) is a **plain, immediately-returning
Postgres query** — no `LISTEN`/`NOTIFY`, no blocking wait, no long-poll mechanics server-side
despite the comment vocabulary. The actual "long-poll" behavior is client-side: the native poll
loop calls it on a fixed **~250ms cadence** (`MultiplayerSession.cpp:333-346,542-544`), which is
exactly why `index.ts:65-70` explicitly **exempts** `/mp/events` from the abuse rate limiter
("the designed steady-state heartbeat (~4/s per peer)").

This is architecturally adequate for 2 peers: 250ms is well inside human perception tolerance
for "I see my collaborator's change a beat later," and the product's own mental model is
explicitly **not** live-jam-together audio (`docs/MULTIPLAYER.md:5-10` — "There is no
synchronized streaming audio between apps... for talking and real-time monitoring you use a
separate voice channel"). Confirming this isn't the actual risk surface: `docs/MULTIPLAYER.md`'s
own "Known limits" section (`:200-204`) lists stale lock badges, buses-don't-replicate, and
tempo last-writer-wins — **nothing about polling latency**.

The archived First-Stranger record supplies the historical "why Realtime" reasoning
(`docs/archive/first-stranger-program-2026-08-23/SPEC.md:47-48`: "Supabase Realtime broadcasts
*references only*") — for the same then-proposed scale reasons as R2 above (4-player sessions,
former FS-S2), not a 2-peer reliability fix. **Defer.**

### Q4 — bounce-on-commit + the relative-ref export hang — **READY (with a scope correction)**

**Scope correction:** `mp_commit_track` (`MoshOps.cpp:2946-3005`) does **not** bounce/render
MIDI or drum clips to audio. It iterates only pre-existing `te::WaveAudioClip*` instances on the
track (`MoshOps.cpp:2958-2982`) — MIDI notes, instrument choice, and plugin state sync as
**structured data**, not audio (`docs/MULTIPLAYER.md:61-63`, independently confirmed by reading
the command). This is a different, unrelated mechanism from the generative-render
"auto-bounce-to-wav" feature (used so re-imagine/transform works on any clip type — see
`CLAUDE.md`'s 2026-06-26/27 working note); that bounce path is not part of MP commit at all. So
"bounce-on-commit," as phrased, doesn't literally happen — and that's a reasonable design choice
(cheaper, keeps content editable on both ends, avoids re-uploading audio on every note edit), not
a gap. One caveat worth a one-line mention to testers: a track loaded with a non-built-in VST3
syncs its *plugin choice*, not audio — if a guest lacks that exact plugin, they get whatever
substitute the load resolves to. The team's own guidance already steers toward "start with MIDI +
the built-in kit/instruments" (`docs/playtest-prep/HOST_CHECKLIST.md:116-117`), which sidesteps
this.

**The relative-source-ref export hang — confirmed FIXED on current `main`:**
- **Write side:** `repointWaveClipSource` (`src/engine/SourceRef.h:36-52`) is now the **one
  shared helper** used by all three call sites that ever rewrite a wave clip's source —
  `mp_commit_track` (`MoshOps.cpp:2978`), `relink_clip` (`MoshOps.cpp:3855`), and the `save_as`
  audio-consolidation pass (`MoshEngine.cpp:505`). It computes the relative ref against the edit
  file's **parent directory** directly, instead of routing through JUCE's
  `setToDirectFileReference`, which (on an unsaved edit) emits a spurious extra `"../"`.
- **Read side:** `MoshEngine::wireEditResolvers`'s `filePathResolver`
  (`src/engine/MoshEngine.cpp:436-465`) resolves a relative ref against the parent dir first,
  falls back to the edit-file-as-directory interpretation the old buggy write path produced —
  belt-and-suspenders.
- The code's own comments name the bug precisely ("This was the 'export hangs on a
  multiplayer-consolidated audio clip' bug," `MoshEngine.cpp:452-453`), matching
  `docs/playtest-prep/followups.md`'s "Update 2026-06-22: item A ... now ROOT-CAUSED CORRECTLY
  and FIXED" resolution block word-for-word in substance.
- **A documentation wrinkle, not a code issue:** two *older*, explicitly-archival playtest-prep
  docs — `docs/playtest-prep/READINESS.md` and `STATUS.md`, both dated 2026-06-21, one day
  *before* the fix — still describe this as an open caveat ("build anything you'll export from
  MIDI + instruments"). Both docs' own headers mark them as closed point-in-time records of that
  specific session ("STATUS ✅ COMPLETE... Prepared on `claude/playtest-prep-0621`... nothing
  merged to main"), and the *current* authoritative docs (`docs/MULTIPLAYER.md`,
  `KNOWN_LIMITS_v0.md`, `HOST_CHECKLIST.md`, all 2026-07-17) correctly omit this caveat. Not
  touched by this audit (not a trivial typo fix; flagging only in case someone stumbles on the
  older doc without noticing `followups.md`'s update block).
- Covered by a dedicated selftest section ("export after commit" per `followups.md`), which
  passed clean as part of this audit's own 1400/1400 MP-selftest runs (§Q6).

### Q5 — Schema versioning gate covers MP fields — **READY**

`src/state/Migrations.h` implements **one global** version for every Mosh-owned ValueTree node:
`kMoshFormatVersion = 1` (`Migrations.h:26`, file-format — refuse-to-open on mismatch) and
`kSnapshotSchemaVersion = 1` (`Migrations.h:32`, C++→UI wire contract — advise-to-update,
degrade-gracefully). `migrateOrRefuse` (`Migrations.h:98-133`) refuses a file newer than this
build (`:103-110`), walks a contiguous migration chain otherwise, and hard-asserts +
error-returns on a broken chain (`:119-125`, the "registry-contiguity invariant" `CLAUDE.md`
documents as unit-tested).

**MP's only *persisted* project-schema field:** `moshLogicalId` (`src/state/Ids.h:75`;
`src/multiplayer/LogicalId.h:17-44`) — a track's stable cross-peer UUID, lazily minted with a
safe absent-default (`LogicalId.h:21-32`, "existing.isNotEmpty() ? return existing :
mint-a-fresh-one"). This already qualifies for the documented "additive optional property ⇒ no
format bump needed" exemption (`Migrations.h:23-24`), and any *future* breaking change to it
would go through this same, already-tested `migrateOrRefuse` gate — there is no separate,
missing, MP-specific versioning scheme to build.

**Everything else is out of scope by design.** Locks, presence/roster, and the room code are
**never persisted** in the project file — they live relay-side (`mp.locks`/`mp.peers` in
Postgres) and reach the UI purely through the ephemeral `mp_state` event, explicitly
**"off-snapshot"** (`docs/MULTIPLAYER.md:95`). So the migration-path question doesn't even apply
to most of what "MP state" colloquially means — only `moshLogicalId` (and `mpBusId`,
`LogicalId.h:35`, same pattern) ever touch the file.

### Q6 — Hermetic MP test coverage — **READY** (reproduced independently by this audit, see evidence below)

### Q7 — Parked branches — **READY: all three already merged to `main`**

| PR | Title | Branch | Status | Merged at |
|---|---|---|---|---|
| **#354** | mp: async stem transfer off the message thread | `claude/mp-async-transfer` | **MERGED** | 2026-07-17T12:02:11Z |
| **#349** | fix(service): don't freeze the message thread when the generative service can't start | `claude/service-spawn-defreeze` | **MERGED** | 2026-07-17T09:08:05Z |
| **#353** | fix(guest): graceful degradation | `claude/guest-degradation` | **MERGED** | 2026-07-17T07:52:52Z |

Verified two independent ways: `git merge-base --is-ancestor <tip-sha> origin/main` returns true
for all three (e.g. `2009fcd8` for #354), and `gh pr view <n> --json state,mergedAt` reports
`MERGED` for all three. **The task brief's "in-flight/parked, not yet landed" framing is stale**
— it mirrors `CLAUDE.md`'s own mid-session working notes ("#354 (async stem transfer...) is
open/mergeable, not yet landed"), written before the merge happened later the same day. Nothing
is blocking any of the three; they're already on `main` at the commit this audit's worktree was
forked from.

**What each carries, playtest-relevant:**
- **#354** — the dedicated `TransferQueue` worker thread (upload/download off *both* the
  message thread *and* the poll thread — the poll thread staying alive matters because a
  multi-minute transfer on it would stop refreshing this peer's own lock leases, per
  `MultiplayerSession.h:64-71`); `mp_commit_track` returns immediately
  (`status:"uploading"`) with completion reported via an additive `mp_commit_done` event;
  `MOSH_MP_SYNC_TRANSFER=1` kill switch to revert to fully-synchronous behavior if the async
  path ever misbehaves live. Also closed, same-day, via its own adversarial review: two
  BLOCKERs (`mp_commit_done` had no frontend consumer — a failed upload was silently dropped;
  `uploadBlob`'s PUT never checked the HTTP status — a rejected upload could read back as a
  false success) and three should-fixes (prefetch race-guard sharing, `running_` teardown
  guards on every job-apply closure, `stemBaseDir` captured at enqueue not at execution).
- **#349** — `GenerativeJobManager::ensureServiceRunning` used to block the **message thread**
  for up to ~30s if the spawned Python service's child died instantly (no working `python3`,
  broken venv) — and because `execute_command` resolves synchronously on the message thread
  (confirmed independently at `src/webview/WebBridge.cpp:152-165`, `src/Main.cpp:280` — no
  `Thread::launch`, unlike `brain_chat`), this could beachball the **whole app**, which during a
  live MP jam "also stalls presence/commit handling (the host sees the guest freeze)" per the
  PR's own description. Fixed via early-bail-on-dead-child + a 5s failure backoff — the PR's own
  RED-first proof shows ~31.9s (unfixed) vs ~0.2s (fixed) for the identical dead-interpreter
  scenario.
- **#353** — guest-Mac graceful degradation: capability-gated clip-menu items (disabled with a
  tooltip when Basic Pitch isn't installed, rather than offering an action that 500s), honest
  503-vs-genuinely-no-melody service error text, "preview" badges on fake
  transform/training surfaces, export-path copy affordances (no native reveal-in-Finder
  command exists). Its own same-day adversarial review caught a **self-inflicted blocker**: an
  eager `loadCapabilities()` in `init()` issued `list_transform_targets`, which — via the exact
  same synchronous-message-thread `ensureServiceRunning` path #349 was fixing — turned into a
  guaranteed ~1.3–2s freeze on **every app launch**, for host and guest alike. Fixed by moving
  the fetch to the same lazy, action-scoped trigger points `loadColors`/`loadTransformTargets`
  already used.

---

## 3. Prioritized playtest-blocker list

None of these block *starting* the playtest. Ordered by how much they're worth relaying to the
two testers up front.

| # | Severity | Effort (to code-fix) | Finding | Evidence (file:line) | Disposition |
|---|---|---|---|---|---|
| 1 | **Medium** | Medium (deferred by team choice) | The documented "idle checkpoint (~5s)" that would publish edits without a track switch **does not exist in code**; combined with a **90s lock lease that is never renewed** while parked on one track, this means (a) your peer sees nothing from a long single-track session until you move off it, and (b) a peer who merely clicks the same track after ~90s can silently steal your lock. | Claim: `docs/MULTIPLAYER.md:51`. Absence: exhaustive grep found no interval/timer anywhere that publishes an MP commit without a track change — native Timers (`MoshOps.h:422-443`) are telemetry/scan/reactive-render only; the only related native timer is a 30s **local-disk-only** autosave (`src/Main.cpp:333-334`, never publishes to a peer); UI has no `setInterval` tied to MP commit (`ui/src/store.ts`, `ui/src/multiplayer/sync.ts`). Lock mechanics: `supabase/migrations/0001_mp_relay.sql:143-160` (90s lease, granted only via `mp_try_lock`), `:182-198` (`mp_events` never touches `lease_expires_at`), `ui/src/store.ts:737-776` (`claim` fires only on a track change). | **Already known and triaged** by the team's own same-day bug sweep (`docs/playtest-prep/SWEEP_2026-07-17.md` rows 3 &amp; 6) with an explicit guidance-only mitigation: `docs/playtest-prep/KNOWN_LIMITS_v0.md:35-39` ("one person per track... if you park somewhere for a while, say so out loud"). This audit independently re-derived and confirmed the same root cause. Recommend: relay that specific guidance verbatim to both testers before the session. |
| 2 | **Medium** | Low (to *verify*; higher to fix if real) | Large audio-stem upload reliability is **untested at realistic sizes**. Every stem-transfer test that exists (hermetic + the live cloud smoke test, including this audit's own run) uses 1–2 **second** tones — tiny. `uploadBlob` does one non-resumable PUT with no automatic retry (only a manual UI "Retry" post-#354). The project's archived research for a *different* system flags that this exact upload mechanism (a raw PUT to a Supabase Storage signed URL) "degrades past ~6MB (TUS required)." | Test sizes: `src/app/SelfTest.cpp` (`add_test_tone_clip` calls, `seconds: 1.0`–`2.0` throughout), `scripts/playtest/mp-live-smoke.sh:39` (`seconds:2.0`). Upload mechanism: `src/multiplayer/MultiplayerClient.cpp:238-311` (single PUT, no retry loop). Size caution: `docs/archive/first-stranger-program-2026-08-23/SPEC.md:325`. Bucket ceiling: `supabase/migrations/0002_mp_blob.sql:5` (50MB). | Not verified true or false by this audit (did not want to leave a persistent, un-cleanable large test artifact in the owner's production Storage bucket without being asked — see §5). **Recommend:** owner does one ~5-minute real test (import/record a 1–3 minute take, commit it, confirm the peer receives it) before relying on longer real takes/SA3 renders in the live session. Cheap insurance either way. |
| 3 | **Low** | — (already fixed) | `uploadBlob` not checking HTTP PUT status (a rejected upload could read back as a false success) — flagged as still-open by the team's own sweep ledger with an explicit "verify #354 has actually merged" action item. | `docs/playtest-prep/SWEEP_2026-07-17.md` row 29. Fix: `MultiplayerClient.cpp:265-271,300-307` (`outStatus` checked at every step). | **Confirmed fixed** — this is exactly the "verify #354 merged" task the ledger asked for; §Q7 confirms it. No action needed. |
| 4 | **Low** | Low (out of primary scope) | The in-app WebRTC video-room feature only configures public STUN (no TURN) — peers behind a symmetric NAT/restrictive CGNAT could fail to connect a video call. | `ui/src/webrtc/signal.ts:19-21` (`DEFAULT_RTC_CONFIG`, Google STUN only). | Not a blocker: the documented/recommended voice channel is Discord (`docs/MULTIPLAYER.md:5-10`), and the camera is off by default (`ui/src/webrtc/useVideo.ts:3-4`). Mention only if the testers plan to use the in-app video instead of Discord. |
| 5 | **Informational** | — | "Bounce-on-commit" doesn't literally bounce anything — MIDI/plugin state syncs as data, not audio (a scope clarification against the task brief's framing, not a bug). A guest lacking a host's exact non-built-in VST3 gets whatever substitute resolves, silently. | `MoshOps.cpp:2946-3005` (only iterates `te::WaveAudioClip*`); `docs/MULTIPLAYER.md:61-63`. | Already steered around by existing guidance ("start with MIDI + the built-in kit/instruments," `docs/playtest-prep/HOST_CHECKLIST.md:116-117`). No action needed beyond awareness. |

---

## 4. R2 / Realtime recommendation

**Do not build either for this playtest. The First-Stranger Program that named S1/S2 is now
paused and archived; this audit does not assign a successor.**

Reasoning, stated plainly:
1. **Neither is a response to a gap in the shipped system.** The current Supabase
   Storage + `mp_events` short-poll design is fully built, self-healing (PR #347), reviewed for
   correctness twice (PR #354's own two adversarial passes), and — as of this audit, today — has
   passed a **fresh, first-party, live two-OS-process round trip over the real production cloud
   relay** (§Q6). There is no known failure mode that switching to R2 or Realtime would fix.
2. **Both were planned infrastructure for a different, larger, later product**, preserved at
   `docs/archive/first-stranger-program-2026-08-23/`, whose stated motivation was **cost and
   fan-out at higher player counts** (`SPEC.md:324-326`), not reliability at n=2. Adopting them
   then would have meant standing up unprovisioned accounts (Cloudflare + R2 bucket,
   `STATUS.md:51`) and rearchitecting a tested, working transport, for a problem this playtest
   didn't have.
3. **The actual, real risks found in this audit (§3) are orthogonal to the transport choice** —
   they're about lock-lease renewal and untested large-file reliability, both of which exist
   *identically* whether the blob store is Supabase Storage or R2, and whether the event feed is
   a 250ms poll or a Realtime push. Swapping infrastructure would not touch either.

Any later decision about R2 or Realtime is outside this historical audit. Its conclusion is only
that neither was a playtest blocker for the two-peer system it examined.

---

## 5. What's UNVERIFIED — needs the owner's hardware or ears

This audit could not and did not attempt to decide these; they require the owner directly:

- **Two real Macs, two real humans, live.** Every automated/scripted proof (hermetic
  multi-peer-in-one-process selftest, and now two genuinely separate OS processes over the real
  cloud relay — §Q6) is a proxy. `docs/playtest-prep/HOST_CHECKLIST.md:87-108` calls the
  two-window dry run on one Mac "the irreducible final gate" for exactly this reason — do that
  first, per the existing runbook, before the actual two-machine session.
- **Real audio output / by-ear quality** — the headless gates never open an audio device
  (`docs/playtest-prep/READINESS.md:28`; still true of every check this audit ran).
- **Large-stem upload reliability under real-world flaky/high-latency conditions** (blocker #2)
  — this audit deliberately did not run an empirical large-file test against the *production*
  Storage bucket (it would leave a permanent, un-cleanable ~tens-of-MB artifact with no delete
  endpoint exposed by the relay, for a question outside this audit's explicit scope). A quick
  owner-run real test (import a real multi-minute take, commit it, confirm the peer gets it) is
  the cheap way to close this before relying on it live.
- **Moshi/agent-voice features** — need an LLM provider key + mic/Speech OS grants; explicitly
  documented as non-blocking for the core DAW/MP/generative loop
  (`docs/playtest-prep/KNOWN_LIMITS_v0.md:54-58`).
- **The in-app WebRTC video room's real-world NAT behavior** (blocker #4) — only relevant if the
  testers choose it over Discord.

---

## 6. Test evidence — what actually ran, and what it produced

All of the following were run **by this audit**, in the `claude/burn-mp-audit` worktree, off a
fresh Release build of `origin/main` at `1044a51b` (built with the project's standard dep-cache
recipe; build succeeded with zero errors, ~7 minutes). A second, independently-launched agent
instance built and ran the same suite separately as cross-checking corroboration (noted inline).

| Check | Command | Result |
|---|---|---|
| Relay Python suite (hermetic, no network) | `python3 -m pytest relay/ -q` | **58 passed in 16.00s** |
| Baseline `--selftest` (no MP env) | `Mosh --selftest` | **1306/1306 checks passed, 0 failed** |
| MP selftest, run 1 (local relay) | `relay/run-mp-selftest.sh` (`MOSH_SELFTEST_MP=1`) | **1374/1400 passed, 26 failed** — coincident with a measured system load average of **33–47 on a 10-core Mac** (`uptime`, many concurrent sibling Claude Code worktree builds sharing the machine) |
| MP selftest, run 2 (local relay, immediately after) | same | **1400/1400 passed, 0 failed** |
| MP selftest, runs 1–3 (independent second build) | same, separate agent instance, same worktree/commit | **1400/1400 passed, 0 failed, all three** — byte-diffed all three full logs; the *only* difference across all three was the embedded session-id timestamp/PID, everything else byte-identical |
| Live two-process cloud round trip (real network, real production relay — **not hermetic**) | `scripts/playtest/mp-live-smoke.sh` | **PASS** — process B (separate OS process) received A's MIDI drum track *and* its audio tone-track's content-addressed stem over `https://tpvkqaqydafpgockzchm.supabase.co`; verified via B's own `__snapshot` (`sourceMissing:false`) and B's saved edit containing both track names; room `hTdHwLXabHJ0CRb2n1-zXw`, stem hash `fbe0bfd3b1ae28234ddfebc7fbab19eb9cca5a66f2fc2603577935aa7435af63` |
| JUCE assertions / leaked objects | grep across all 5 selftest logs | **None found** in any run |

**Reading the one non-clean run honestly:** 4 of 5 total `MOSH_SELFTEST_MP=1` runs across two
independently-built binaries were clean and byte-level deterministic. The one exception (run 1,
26 failures) coincided with an independently-measured extreme load spike on a machine running
many other concurrent builds — this is the *exact* flake class the project's own verification
notes already documented and root-caused: `docs/MULTIPLAYER.md:219-227` records a prior
1-failure-in-7-runs sample under a *lower* load condition (">9 on a 10-core box"; this audit's
flaky run measured 33–47), attributed to timing-sensitive "audio stems" completion-wait checks
racing background compilation load, not a logic defect. This audit's results are consistent with
that account, not a new regression.

**`mp-live-smoke.sh` scope note:** this script needs real network egress to the production
Supabase project (confirmed reachable — a plain `curl` to its `/health` endpoint returned HTTP
200 before running anything). It is the team's own sanctioned "real playtest path" check (PR
#354's body reports the same script run twice, same day, both PASS) — this audit's run is a
third, independent, fresh confirmation from today.

---

## 7. Answering the task brief directly

- **Branch:** `claude/burn-mp-audit`
- **Per-question verdicts:** Q1 READY · Q2 DECISION (Supabase Storage, defer R2) · Q3 DECISION
  (short-poll, defer Realtime) · Q4 READY · Q5 READY · Q6 READY · Q7 READY (all merged)
- **Top playtest blockers:** none are launch-blocking; see §3 for the full, cited, severity-ranked
  list — the two worth actively relaying to testers are #1 (lock-lease/idle-checkpoint — "one
  person per track, say so if you park") and #2 (do one real large-take test before the session).
- **R2/Realtime recommendation:** defer both — reasoning in §4.
- **UNVERIFIED (needs owner hardware/ears):** listed in §5 — principally the live two-human
  two-Mac session itself, real audio-by-ear, and one cheap large-file upload spot-check.
- **Parked-branch merge status:** #354, #349, #353 are **all already merged to `main`** (§Q7) —
  the "parked" framing in the task brief was stale.
