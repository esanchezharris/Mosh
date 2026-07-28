# First-Stranger Program — Master Spec (2026-07-11)

**Status: ACTIVE. Decision-complete. Amended 2026-07-12: license claims verified against primary
sources; K4 now adopts the companion `docs/DEPENDENCY_BOM.md`. Supersedes nothing; sits alongside
the 2026-07-11 Status & Handoff doc.**

*Audience: Claude Code sessions. Constraint: the first human who isn't the owner uses Mosh in ~6 weeks
(playtest #1: 3 people incl. one true novice, remote, their own Apple Silicon Macs). This spec is the
entry point for all work in the window. §1–§2 are settled — do not re-open, do not propose
alternatives. If a gate proves unachievable as written, STOP and report; do not substitute a
different design.*

---

## §0. Execution rules (read before any lane)

- **One lane per worktree.** Follow the existing worktree pattern. Do not cross lanes in one branch.
- **MoshOps is the sole mutation seam.** No exceptions, including multiplayer and autosave paths.
- **Local gate discipline.** GitHub Actions may be billing-blocked. Every gate below must be runnable
  locally. Baselines to preserve on every merge: `--selftest` ≈1254–1260 ×3 deterministic,
  Catch2 ≈494, vitest ≈874, Playwright e2e 125/125 (use `ui/playwright.isolated.config.ts` / port
  5191 if `:5173` is owned). `tsc` clean.
- **Nothing a build reads lives under `~/Documents`.** All new caches/artifacts under `~/Library/Mosh/`.
- **Build recipe** (verified 2026-07-10): `cmake --preset macos-arm64-release`
  `-DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache`
  `-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`.
- **Do not touch parked threads** (§2). Do not modify `arena/`, the SA3 LoRA branch, FMS spike
  worktrees, or `PROGRAM_STAGE1` beyond the freeze memo task (B0).
- **First session per lane:** expand that lane into a gate-registered plan in the repo's existing
  style (and/or `docs/auto-loop/backlog.jsonl` entries using the schema already present in that
  file — read it first, don't invent a schema). Then execute.
- **Verify the gap before building it.** Some repo docs are stale (June 2026). Each lane's first act
  is to confirm its target gap still exists in the current tree (grep the bundled-key path, check for
  autosave code, etc.) and record the evidence in the lane plan. If a gap is already closed, report
  and stop — don't rebuild it.
- Each lane below lists **BLOCKED-ON-OWNER** items. If a lane's blocker is unmet, do prep tasks only
  and report; do not improvise around the blocker.

---

## §1. Decisions record — settled 2026-07-11, do not re-litigate

1. **r5 is CLOSED** (not parked). The r4 adapter (`~/AI/adapters/a3b-r4-cuda-pull`, sha `2f29b655…`)
   is retained as an interim brain. The 12,994 `s2-mix-v5` rows are retained as a workflow corpus for
   future skill mining (parked, §2).
2. **Take storage = Cloudflare R2, content-addressed.** The op-log/state carries a content hash;
   the blob lives in R2. Supabase remains for auth/Postgres/Edge Functions/Realtime. Supabase
   Realtime broadcasts *references only*, never audio bytes (payload cap is 256KB free / 3MB pro).
   Supabase Storage is not used for takes.
3. **Bounce-on-commit.** What commits and propagates in a session is *rendered audio* through the
   committer's chain — never a plugin-dependent project fragment. Fits existing freeze/bounce
   machinery. This is the answer to plugin non-portability across peers.
4. **Opus proxy now, WAV lazily.** On commit, a 96–128 kbps Opus proxy propagates immediately
   (transparent for music at these rates); the full WAV backfills in the background and upgrades the
   clip source in place.
5. **Brain key goes server-side.** A Supabase Edge Function proxy holds the provider key as a
   secret; the client carries only a per-install UUID. Per-UUID daily budget enforced in the
   function; provider-side spend limit as belt-and-suspenders. No provider key ever ships in the
   bundle again. Rationale (do not soften): extracted keys are abused within minutes-to-days;
   documented worst cases exceed $40k/day.
6. **Schema versioning lands BEFORE any new multiplayer/session state fields.** Hard sequencing
   dependency: T3 → S1/S2.
7. **Playtest scope: Mac-only, 4-player ceiling** for the window. Windows verification is parked
   (§2). First external testers are on Apple Silicon Macs they already own.
8. **Cloud brain via proxy is the serving path for the window.** No local router model work in the
   window. (Small-model constraint noted in Lane B for later: 1–4B models are viable only for
   single-turn template-selection + typed-slot-filling with grammar-constrained decoding; multi-turn
   tool-calling collapses at that size.)
9. **House-principle wording** for any user-facing or pitch copy: *"everything starts from something
   real of yours"* (not "Mosh doesn't invent" — SA3 layers do invent).
10. **Demo/script guardrail:** the novice must visibly perform (hum, tap, choose). Moshi removes
    software labor, not musical labor. Applies to the demo script and to skill design.
11. **Distributed builds ship without RAVE/anira** (`-DMOSH_ENABLE_ANIRA` OFF, artifacts and weights
    absent from the package). VERIFIED 2026-07-12: upstream RAVE code and official weights are
    CC BY-NC 4.0, and a VC-track startup's app — even free — is not a defensible non-commercial use.
    Keeping the integration privately in-tree, undistributed, creates no obligation (CC duties attach
    on sharing). If RAVE is ever wanted in-product, the path is a commercial license from
    IRCAM/IRCAM Amplify (precedent exists: Qosmo's Neutone). Enforced as a K1 packaging check.
    MIT/Apache deps (ACE-Step 1.5, SoulX, Qwen3-30B-A3B) are unaffected.
12. **Demo integrity rules** (bind O2 and anything filmed): real source takes; source preserved; no
    hidden hand edits; honest elapsed processing time on screen; three consecutive full runs before
    anything is called demo-ready; never cut around cleanup the product can't do itself.

---

## §2. Kill / Park ledger

| Item | Status | Date | Revisit |
|---|---|---|---|
| SFT r5 run | **CLOSED** | 2026-07-11 | never (target deprecated) |
| Windows hardware verification | PARKED | 2026-07-11 | after playtest #1 (~wk 6) |
| FMS Phase 3 execution (ACE promotion / SoulX bring-up / voice-LoRA pod) | PARKED after week-1 verdict | 2026-07-11 | ~month 3, release-a-song lane |
| Designer Arena machinery (new rounds, Summon, Gemini key) | PARKED — harvest-only | 2026-07-11 | post-playtest |
| SA3 LoRA trainer branch | PARK behind a tag; **do not merge** | this week | only if beat lane demands, post pack-009 |
| Skill learning v2 / sharing v3 (incl. mining the 12,994 rows) | PARKED | 2026-07-11 | post-playtest |
| Out-of-process plugin hosting | OUT OF WINDOW | 2026-07-11 | mitigations: autosave (T2), allowlist, `block_plugin` |
| Android | PARKED | standing | — |
| Beat packs | labels-only; no pipeline work | standing | pack-009 |

---

## §3. Owner-only critical path (not agent work — listed so lanes know their blockers)

- **O1. Apple Developer enrollment** ($99, ~1–2 days to approve). Gates Lane K. Start immediately.
  **✅ CLOSED 2026-07-27** — enrolled; proven end-to-end by FS-K1 (notarized+stapled DMG,
  `spctl` accepted) and FS-K2 (signed update round-trip). Lane K is no longer owner-blocked.
- **O2. ~~Demo script~~ — WITHDRAWN 2026-07-28 (owner: "we're not doing a demo anymore").**
  Not "closed"; the deliverable no longer exists, so nothing downstream may keep waiting on it.
  Consequences, so no future session re-derives them:
  - **Lane B is no longer O2-blocked.** FS-B3 (router) now waits only on FS-T1.
  - **FS-B2's acceptance is unsourced.** "The first ~10 skills *from the demo beats*" has no
    demo to come from. It is re-blocked on an owner decision about the replacement source, NOT
    on a script. The obvious candidates, in the tree today: mine them from real session logs
    (`service/skills/mine.py` already does this — script-independent by construction), promote
    from the 36-entry mined `service/skills/library.jsonl`, or hand-pick from the shipped
    9-skill `ui/src/agent/skills.ts`. That choice is §1-class and belongs to the owner.
  - **§1.10 (demo/script guardrail) and §1.12 (demo integrity rules) are moot as written.**
    Their *substance* is not: "the novice must visibly perform — Moshi removes software labor,
    not musical labor" is a product principle that outlived the demo, and skill design should
    still obey it. Treat §1.10 as a design rule, §1.12 as dormant until something is filmed.
  - **O5's "pick what fits the script" wording is dead**; judge the arena on merit instead.
  - **O3's framing dies with it** — it existed to decide the demo's hero beat vs fallback beat.
    See O3 below.
- **O3. ~~FMS seed verdict~~ — DEAD 2026-07-28**, because it was a demo gate ("PASS = ≥2/8
  ***demo-worthy***") and O2 is withdrawn. FMS itself did not stop.
  **This spec does not track FMS state and must not start.** That programme is owned by its
  own lane — read `docs/fms-lyrics-bench/PROGRAM.md` for what the owner currently owes it.
  Restating its asks here would go stale the moment that lane moves, and then two documents
  would disagree about what is owed. (A bullet doing exactly that was written here and backed
  out the same day.)
- **O4. Accounts & secrets:** Cloudflare account + R2 bucket; provider LLM key into Supabase
  function secrets (**must be a commercial API key**, per BOM §3); rotate/revoke the
  currently-bundled key once T1 lands; register Stable Audio commercial use at stability.ai
  (free, minutes — required for the "Powered by Stability AI" compliance in K1).
- **O5. Arena harvest hour** — *mostly done, and the "~38 candidates" figure is wrong.*
  `~/Library/Mosh/work/arena/.arena-verdicts.json` (dot-prefixed — an earlier probe missed it)
  holds **6** candidates, **4 already `promoted`** by the owner. Two remain unjudged:
  `seed-shell-obsidian` and `kimi_l_55ko`. Judge on merit — the "fits the script" criterion died
  with O2. Gates ST1.
- **O6. Housekeeping** (½ day): fast-forward local `main`; commit/discard the uncommitted
  `service/lyrics/core.py` + untracked files; delete iCloud `… 2.*` dupes; prune stale worktree;
  tag + park the SA3 LoRA branch.

---

## §4. Lane T — Trust ("never lose their song") — READY NOW

### T1. Brain-key token proxy
- **Scope:** New Supabase Edge Function (e.g. `brain-proxy`) exposing an OpenAI-compatible chat
  endpoint; provider key as a function secret. Client: per-install UUID minted on first launch
  (stored in Keychain; registered in Postgres), sent as a header. Per-UUID daily token budget +
  rate limit enforced in the function; usage logged per UUID. `src/brain/BrainProxy.cpp` retargets
  to the function URL; delete the bundled-key path entirely.
- **Non-goals:** device attestation, user accounts/OAuth, streaming beyond what the UI already
  needs, multi-provider routing UI.
- **Provider-terms conditions (verified, see BOM §3):** the proxy must hold a **commercial API key**
  — never a consumer subscription. Forward the per-install UUID, hashed, as the provider's end-user
  identifier (Anthropic `metadata.user_id` / OpenAI `safety_identifier`); never any PII in those
  fields. Serving end users through the developer's key via a proxy is the providers' intended
  model — this is compliance detail, not a workaround.
- **Gates:**
  - `strings` over every binary/resource in the packaged `Mosh.app` finds no provider key or
    key-shaped secret (add as a scripted check to the deploy path).
  - Packaged app with **no** local env keys gets working Moshi via the proxy.
  - A UUID over budget receives a clean, user-visible refusal (not a crash/hang); integration test
    hits the deployed function.
  - Proxy calls carry the hashed per-install identifier in the provider metadata field; no PII
    (verified in the integration test).
  - Old bundled key revoked (O4) and the app still works.

### T2. Autosave + crash recovery
- **Scope:** Interval snapshot + JSONL replay-from-snapshot. `mosh-log.jsonl` is the primitive.
  Recovery prompt on relaunch after unclean exit. Save-on-quit / unsaved-changes prompt.
  Relaunch-after-plugin-crash additionally offers "open without third-party plugins" (safe mode),
  with the suspect plugin blocklisted via the existing `block_plugin` lever.
- **Non-goals:** cloud backup, project portability/consolidation, Recent list (nice-to-have only if
  free), OOP plugin hosting.
- **Gates:**
  - `kill -9` mid-edit (scripted: N mutations, kill, relaunch) → recovered state matches the
    pre-kill snapshot+replay to the last logged command. Deterministic, ×3, added to selftest or a
    dedicated harness gate.
  - Recovery works after a plugin-induced abort (simulate via the existing harness crash path).
  - No audio-thread allocations/locks introduced (RT-safety review on any engine-adjacent code).

### T3. Project-file schema versioning
- **Scope:** Version int in the project/session state; forward-migration scaffold (vN reads vN-1);
  refuse-with-message on unknown future versions. Migration test fixture pattern.
- **Non-goals:** backward-write, multi-hop migration beyond one version for now.
- **Gates:** vN opens a committed vN-1 fixture via migration; a synthetic v(N+1) file fails safely
  with a clear message; selftest coverage. **Must merge before S1/S2 add state fields.**

---

## §5. Lane K — Ship kit — BLOCKED-ON-OWNER: O1 (prep tasks may proceed)

### K1. Sign + notarize + staple DMG
- **Scope:** Developer ID signing with hardened runtime (`--options=runtime --timestamp`) over all
  binaries incl. the Python service payload; `xcrun notarytool submit --wait`; staple the DMG
  (`create-dmg` or equivalent); scripted end-to-end in `scripts/` (local-runnable; CI optional).
  Entitlements: `com.apple.security.cs.disable-library-validation` (required to host third-party
  VST3/AU), WKWebView JIT entitlement(s) (`allow-jit`; verify empirically what the JUCE
  WebBrowserComponent/WKWebView actually needs — add the minimum that passes), mic usage string +
  audio-input entitlement. **Notices & attribution:** an acknowledgements surface (about screen or
  bundled NOTICES file) carrying every BOM §1 row that ships — including "Powered by Stability AI"
  (required when SA3 ships) and "Powered by Tracktion Engine" (required on the free Tracktion
  tiers). **Packaging check (scripted, blocking):** no RAVE/anira artifacts or weights in the
  bundle (§1.11); all required notices present; enumerate what the packaged `service/` payload
  actually bundles — anything shipped must have a BOM row (parked FMS-stack models must not ship).
- **Gates:** On a clean macOS user account: mount DMG → drag → launch with zero Gatekeeper
  overrides; third-party VST3/AU still load; mic permission prompt appears and recording works;
  Moshi works (proxy, T1); packaging check green.

### K2. Sparkle 2 auto-update
- **Scope:** Sparkle 2 via CMake; EdDSA keys (`generate_keys`, private in Keychain);
  `SUPublicEDKey` in Info.plist; static appcast (GitHub Pages or S3/R2); `generate_appcast` wired
  into the release script.
- **Gate:** Full round-trip on a test machine: install v0.0.x → publish v0.0.y → in-app update →
  relaunch on v0.0.y, still signed/notarized.

### K3. Crash reporting
- **Scope:** Sentry Native SDK (crashpad backend, out-of-process handler); dSYM upload in the
  release script; first-run consent copy (opt-in). Free tier (5k events/mo) is sufficient.
- **Gate:** Induced crash in a release build appears in Sentry, symbolicated. Opt-out honored.

### K4. Dependency & license BOM — VERIFIED 2026-07-12; adopt, wire, maintain
- **Scope:** Land the companion `docs/DEPENDENCY_BOM.md` (delivered alongside this spec; verified
  against primary license texts — EULA pages, LICENSE files, HF model cards). Wire its enforcement:
  the K1 packaging check, and the funding-trigger thresholds recorded where the owner will see them
  at raise time. Do not re-derive the research.
- **Key verified facts — do not re-litigate:** Tracktion Engine and JUCE 8 caps count **funding as
  well as revenue** (quoted in the BOM); JUCE 8 Indie caps at **$300K** (the $500K figure in older
  notes is JUCE 7 — stale); Stability's $1M cap is **revenue-only** — a raise does NOT trip it;
  ACE-Step 1.5 MIT (v1 was Apache-2.0 — record the version), SoulX Apache-2.0, Qwen3-30B-A3B
  Apache-2.0 (other Qwen variants may differ — re-check before adding any), Sparkle MIT,
  sentry-native MIT (the SDK; server licensing differs, irrelevant), Opus BSD — all clean.
- **At-raise purchases (owner, threshold-triggered):** raise ≥$300K → JUCE Pro — prefer $3,500
  perpetual/seat over $175/mo (subscription seats must stay active to keep distributing);
  raise ≥$400K → Tracktion Pro 2 ($150/mo, subscription-only, 12-mo commitment); raise >$2M →
  Tracktion Pro 3 ($300/mo). Budget ~$3.6–5.3k year one into the round's use-of-funds.
- **Counsel-check before the raise closes (not before the playtest):** JUCE EULA §1.12 "Products
  That Create Products" as applied to an agent-hosting DAW (read: audio output is exempt static
  content — low risk, broad wording); the RAVE NonCommercial determination (conservative do-not-ship
  read adopted).
- **Non-goal:** the (A)GPL fallback. Verified non-viable — copyleft would capture the whole conveyed
  app, and the bundled model weights (CC BY-NC, Stability Community License) are not GPL-compatible.
  Buy commercial; never propose open-sourcing around the fees.
- **Gate:** BOM merged; K1 packaging check green; at-raise thresholds recorded in the BOM and
  referenced from the fundraise notes.

---

## §6. Lane S — Session (2 → 4 players) — S0 READY NOW; S1/S2 depend on T3 and S0's output

### S0. Sizing spike — TIMEBOXED 2–3 days, output is a report, not fixes
- **Scope:** 3 instances across 2 machines through the current relay. Measure: (a) commit
  propagation time for a ~50MB take end-to-end today; (b) late-join and **rejoin-after-network-blip**
  behavior (the demo-killing failure — make this measurement #1); (c) relay/Supabase limits hit;
  (d) duplicate-delivery behavior across a reconnect — does the current relay ever double-apply a
  command?
- **Gate:** A written report in `docs/` with numbers + a sized S1/S2 plan. Nothing merges from S0.

### S1. R2 asset path (content-addressed takes)
- **Scope:** On keep/commit: hash the audio (reuse the RenderLayer SHA-256 fingerprint pattern),
  encode Opus proxy (96–128 kbps), upload proxy then WAV to R2 via short-lived presigned URLs minted
  by a Supabase Edge Function; broadcast the reference over Realtime; peers resolve missing hashes
  from R2 and upgrade proxy→WAV in place. Local content cache under `~/Library/Mosh/`.
- **Non-goals:** WebRTC/P2P transfer (revisit only if egress cost or immediacy ever demands it),
  TURN infrastructure, same-room clock-sync listening.
- **Gates:**
  - Kept take audible on a second peer **< 5s** (proxy) on residential connections, ×3.
  - WAV backfills and replaces the proxy without audible interruption or edit invalidation.
  - Cache hit ⇒ zero refetch (verified via logs).
  - All mutations still flow through MoshOps; contract tests updated.

### S2. 4-player session
- **Scope:** Relay + session state for 4 peers; late-join catch-up v1 (snapshot + JSONL replay);
  rejoin-after-blip without forking; bounce-on-commit v1 (§1.3); minimal track-lock UX
  (Moshi-mediated conflict copy can be a stub line, not a feature). **Session-layer envelope:**
  every propagated command carries an idempotency key (`operation_id`) plus the expected project
  revision; duplicate deliveries are no-ops; stale-revision proposals are rejected cleanly. The
  session event feed carries a strictly monotonic per-project cursor; late-join/rejoin = snapshot +
  replay from the peer's last acked cursor.
- **Non-goals:** 5–6 players, presence polish, group-listening sync-start (only if trivially free
  after the above; otherwise post-window).
- **Gates:** Scripted 4-user session (4 instances / 2 machines acceptable) survives join → edits →
  leave → rejoin → commit storm with **zero data loss** and converged state, ×3 deterministic.
  Deliberately duplicated/replayed command deliveries never double-apply (idempotency verified in
  the scripted session). Selftest/conformance additions for new commands.

---

## §7. Lane B — Brain: skills + router — BLOCKED-ON-OWNER: O2 (B0/B1 harness may proceed)

### B0. Freeze memo
- Draft the r5-freeze memo into `docs/bench/PROGRAM_STAGE1_2026-07.md` (r5 CLOSED; r4 adapter
  retained as interim brain; rows retained as corpus). Owner approves wording before merge.

### B1. Skill schema + harness (script-independent)
- **Scope:** Skill = name + NL description + typed slots + MoshOps template (with control flow) +
  preconditions + engine-mock-assertable postcondition. Harness: run a skill against the engine
  mock, assert postconditions; contract test ties the skill catalog to the real command surface
  (extend the existing `commands.contract.test.ts` pattern). Slot filling is schema-validated.
- **Gate:** One reference skill passes the harness end-to-end; catalog/contract test green.

### B2. First ~10 skills — from the demo script's beats (O2), not from a DAW taxonomy
- **Gate:** Each skill passes the mock harness AND one real-engine run; failure modes produce
  user-legible refusals, never partial mutations (one undo txn per command still holds).

### B3. Router v1 — cloud brain via the T1 proxy
- **Scope:** Retrieve candidate skills → select → fill typed slots → confirm/execute. Eval set built
  from the script's utterances + paraphrases.
- **Gate:** ≥90% top-1 skill selection on the scripted-utterance eval, and 100% of executed fills
  are schema-valid (invalid fills must be caught pre-execution, not post).

---

## §8. Lane ST — Stage (owner-taste-gated; low agent autonomy)

- **ST1.** Arena harvest (1 day, after O5): port only owner-picked elements into `ui/src/v2`.
  **Default-win rule:** if nothing clearly wins in the harvest hour, current v2 wins by default and
  ST2 shrinks to polish-only or is skipped. No further Arena rounds either way (§2).
- **ST2.** "Toy, not tool" pass on the v2 shell — HARD TIMEBOX 3–4 days. Bar: the scripted demo
  reads as *fun* in a video frame. Owner eyeball is the gate; do not iterate past the box.

---

## §9. Week map

- **Wk 1–2:** T1 → T2 → T3; S0 spike; K prep (scripts, entitlement plist, Sparkle scaffolding)
  pending O1; B0 + B1. Owner: O1–O6.
- **Wk 3–4:** S1 → S2; K1 → K2 → K3; B2 → B3; ST1 → ST2.
- **Wk 5:** Playtest #0 (owner + one pro-ish friend, remote, full flow: install via DMG → session →
  commit → export). Fix list. Skills round 2 from the observed "Moshi couldn't do X" log.
- **Wk 6:** Playtest #1 (3 people incl. one novice). Collect consented JSONL logs from all peers.
- **Wk 7–8:** Playtest #2 with fixes; landing page + waitlist (1 day); phone-companion TestFlight
  only if all lanes green.
- **Playtest #1 success criteria (falsifiable):** the novice keeps a take they're proud of without
  anyone touching their machine or directing clicks; zero data loss across the session; they ask
  when they can do it again.

---

## §10. Inlined research constraints (so this spec stands alone)

- R2: zero egress; ~$0.015/GB-mo storage; at plausible playtest scale the take bill is ~$15–25/mo.
  Supabase Storage egress ($0.09/GB) makes it wrong for fan-out; standard upload path degrades past
  ~6MB (TUS required) — hence Decision §1.2.
- Supabase Realtime payload caps: 256KB (free) / 3MB (pro) — references only.
- Opus 96–128 kbps stereo is transparent for music (Xiph listening tests); a proxy of a 50MB WAV is
  a few hundred KB — hence the <5s S1 gate is realistic.
- Extracted bundled keys: found via `strings`/traffic inspection; abuse begins in minutes-to-days;
  worst-case documented burn >$40k/day — hence T1 precedes any external DMG, non-negotiable.
- Notarization: `notarytool` (not `altool`); hosting third-party plugins requires
  `com.apple.security.cs.disable-library-validation`; staple the DMG.
- Sparkle 2: EdDSA; appcast can be fully static; no server code.
- Sentry free tier: 5k events/mo — fine for invite-only.
- Small models (1–4B): single-turn template+typed-slot+grammar only; multi-turn tool-calling
  collapses (BFCL multi-turn: Qwen3-4B ~35%, xLAM-2-1b ~8%) — hence Decision §1.8 keeps the cloud
  router for the window.
- Licensing — VERIFIED 2026-07-12 against primary sources; full detail + operative clause citations
  in `docs/DEPENDENCY_BOM.md`: RAVE CC BY-NC 4.0 → §1.11 exclusion (private in-tree = no
  obligation); Tracktion and JUCE caps count revenue **or funding** — at-raise purchases in K4;
  Stability's $1M cap is revenue-only, with registration + "Powered by Stability AI" attribution
  required now; ACE-Step 1.5 MIT, SoulX Apache-2.0, Qwen3-30B-A3B Apache-2.0, Sparkle/sentry-native
  MIT, Opus BSD — clean.
- Provider API terms (verified): a token proxy serving end users on the developer's commercial key
  is the providers' intended deployment model — conditions in BOM §3 (commercial key only, hashed
  non-PII end-user identifiers, no raw-API resale) are wired into T1.
- Competitive note for pitch language (reported 2026-07-09, unverified): FL Studio 2026's Gopher now
  performs some in-DAW actions. Do not pitch "the only agent that operates a DAW"; pitch verified-
  skill reliability (typed, testable, undoable) + the party/social frame, which Gopher has neither
  of.
