# Mosh — Hardware Verification Runbook

*Closing the gap between "passes `--selftest` plumbing" and "**actually** produces correct audio /
responds to a mic / syncs between two peers."*

Most of Mosh is proven by the deterministic command-surface harness (`Mosh --selftest`, ~784
checks) plus the UI suites (vitest + Playwright). Those prove the *plumbing*. This runbook proves
the parts that only real hardware (or real audio rendering) can confirm.

**Primary proof vehicle = offline render-to-WAV.** Rather than live-listening or BlackHole
loopback, we bounce the real signal chain to a file (`export_audio` / `bounce_layer_to_clip`, plus the
render-layer job artifacts) and assert on the WAV's contents programmatically
(non-silent? expected level? did the Tier-B transform / SA3 actually change the audio vs its input?).
This is deterministic, headless, and needs no one present — you can audition the saved WAVs later.
Only a few checks are inherently live (mic/voice, two-window multiplayer sync).

## Prerequisites

| Need | For | Present on this machine |
| --- | --- | --- |
| Release `/Applications/Mosh.app` built from current `main` | everything | rebuild via `./run-mosh.sh deploy` |
| `service/.sa3.env` wired (`service/setup-sa3.sh`) | SA3 transform check | model present at `~/AI/stable-audio-3/optimized/mlx`; run setup to wire |
| `numpy` | WAV analysis | numpy 2.4.4 ✓ |
| Microphone + Privacy→Microphone grant | voice, recording | owner-provided, live |
| `ui/.env.local` brain key | full STT→LLM→command loop | **not used this pass — voice tested against the mock brain** |

## The harness

`scripts/verify-hardware/` (a driver that runs `Mosh --run-script` headlessly to render
evidence WAVs into `verify-artifacts/`, plus a numpy/`wave` analyzer that asserts each WAV and
prints a pass/fail report — see [`scripts/verify-hardware/README.md`](../scripts/verify-hardware/README.md)):

```bash
python3 scripts/verify-hardware/verify.py          # offline checks (1,2,3,5) — self-driven, deterministic
python3 scripts/verify-hardware/verify.py --sa3     # also the real SA3 transform (needs service/setup-sa3.sh)
python3 scripts/verify-hardware/verify.py --rave    # also the real RAVE transform path (needs service/transform/setup-transform.sh)
python3 scripts/verify-hardware/verify.py --rave-insert --bin build-anira/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh
                                                    # the real-time RAVE insert offline render (anira build + transform venv); asserts gap-free
# live checks (6,7,8 — owner-driven) are listed per-row below.
```

## Checks

Results below from the 2026-06-20 pass (offline checks are deterministic — WAV checksums stable
across runs).

| # | Check | Kind | Asserts | Status |
| --- | --- | --- | --- | --- |
| 1 | Makes sound | offline | non-silent, right duration/level | ✅ 2.0s stereo, peak 0.18, RMS 0.12 |
| 2 | Drums audible | offline | non-silent (silent-drums regression guard) | ✅ 4.0s, peak 0.91, RMS 0.088 |
| 3 | Transform render (fake) | offline | Tier-B `transform` (fake adapter) renders non-silent, differs from input | ✅ `adapter/mode: transform`, **diff-from-input RMS 0.270**, RMS 0.45 |
| 4 | SA3 transform | offline (`--sa3`) | real model renders, quality readout present, differs from input | ✅ `adapter: stable_audio3`, **`pq 6.933`**, non-silent |
| 4b | RAVE transform (real path) | offline (`--rave`) | real `torch.jit` RAVE encode→decode renders non-silent, differs from input | ✅ `backend: rave`, out-RMS 0.71, **diff-from-input 0.37** (synthetic scripted model; user drops real `.ts`) |
| 4c | RAVE insert, real-time (Route C.2) | anira build (`-DMOSH_ENABLE_ANIRA=ON`), offline (`--rave-insert`) | a RAVE insert in the render graph transforms audio AND the offline export is **gap-free** (the C.2 follow-up: anira switches to non-real-time/blocking mode when `PluginRenderContext::isRendering`, so a faster-than-real-time render never drops blocks) | ✅ anira 2.1.0 + LibTorch 2.4.1; `add_rave_insert modelLoaded:true`; wet ≠ dry (**diff-from-dry RMS 0.396**), non-silent, **max exact-zero run = 1 sample** (threshold 256 → no missing-sample gaps); synthetic scripted model, user drops a real `.ts` |
| 5 | Full producer loop | offline | multi-track + mix exports non-silent | ✅ 2.0s, peak 0.34, RMS 0.18 |
| 5b | Relative-ref export (MP-hang guard) | offline | a wave clip with a RELATIVE source ref (multiplayer `mp_commit_track` / `relink_clip` on an unsaved edit) exports WITHOUT hanging (timeout-protected) + non-silent | ✅ fixed 2026-06-22 (resolver `../` asymmetry); was an infinite `ArrangerLauncherSwitchingNode` render-graph recursion |
| 5c | Bypass layer re-route (A/B) | offline | `bypass_layer{true}` RE-ROUTES real audio — it mutes the landed neural clip so the export collapses BACK to the original (pre-render) source, not just flips a status flag | ✅ AL-008: accepted render moves the mix clear of the original (**rendered-vs-orig RMS ≫ 0**) and bypass snaps it back (**bypass-vs-orig RMS ≈ 0 ≪ rendered-vs-orig**) |
| 6 | Realtime output path | live | device opens; audio frames flow | ✅ `--live-audio-smoke` **14/14** (MacBook Pro Speakers, CoreAudio 48k) — by-ear out-loud confirm still owner-side |
| 7 | Voice (mock brain) | live | STT transcribes; earcons fire | ⏳ owner: grant mic, hold-to-talk + 👂 hands-free + barge-in (`MOSH_VOICE_BARGE_IN=1`) |
| 8 | Multiplayer (2-process) | live | protocol green; track-lock + clip-move sync | ✅ `relay/run-mp-selftest.sh` **911/911** — two-window *visual* sync still owner-side |
| 9 | Sketch (beatbox→drums) | gated | recognizable kick/snare/hat land in a real editable clip; tempo set; byte-identical across runs | ✅ `MOSH_SELFTEST_SKETCH=1` **16/16** on the committed fixtures (boom-bap 90 + trap 140), determinism asserted; CLI stdout byte-identical across runs |

**Sketch gated selftest** (needs `service/sketch/setup-sketch.sh` first):

```bash
MOSH_SELFTEST_SKETCH=1 MOSH_SKETCH_FIXTURE_DIR="$PWD/service/sketch/fixtures" \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest   # run from the repo root
```

The default `Mosh --selftest` (no env) stays **893/893** whether or not the librosa venv is present
(graceful degradation). Remaining hands-on for Sketch: the by-ear "does it groove" confirm and a
real beatbox-from-your-mouth take (the fixtures are synthesised, not recorded) — owner-side.

Evidence WAVs + the analyzer `report.json` land in `verify-artifacts/` (git-ignored). The
`--run-script` runner and the harness live in PR #80; this runbook in #78.

## Re-running

The offline checks (1–5) are deterministic — re-run `python3 scripts/verify-hardware/verify.py`
(add `--sa3`) any time a change could affect the signal chain, as a render-level regression guard
on top of `--selftest`.

## Collaborator video — two machines (hardware-gated)

The WebRTC + signaling layer is built and unit-tested (`ui/src/webrtc/*.test.ts`,
`relay/run-mp-selftest.sh`); the macOS 12+ camera permission delegate
(`src/webview/WebViewCameraPermission.mm`) unblocks `getUserMedia` in the packaged app.
This is the operator procedure to prove peer video on real hardware.

1. **Build/deploy** Mosh on both Macs: `./run-mosh.sh deploy` (or copy `/Applications/Mosh.app`).
2. **Relay** — pick one:
   - *Cloud (default, zero-config):* nothing to do; the Supabase relay is baked in.
   - *Local:* on Mac A run `PORT=8771 python3 relay/server.py`; on **both** Macs
     `export MOSH_RELAY_URL=http://<MacA-LAN-IP>:8771` before launching.
3. **Session** — host creates a session (gets a room code); guest joins with that code.
   Confirm each Mac shows the other in the presence cluster.
4. **Camera** — on each Mac, accept the macOS camera prompt (first time), then click the
   camera toggle. Expect: each sees the other's live tile in the Session rail; toggling
   off removes the remote tile and the camera light goes out.
5. **Same-Mac smoke (optional)** — two Mosh instances on one Mac (sharing the one camera)
   partially checks signaling + tiles without a second machine.
6. **Troubleshooting** — no remote video:
   - System Settings → Privacy & Security → Camera → ensure Mosh is enabled.
   - Relay reachability: `curl <MOSH_RELAY_URL>` from both Macs.
   - The Console log line `[webview] camera permission delegate installed` confirms the
     delegate attached (absent → it didn't find the WKWebView; camera will fail).
   - Same-LAN works with STUN only; cross-NAT may need a TURN server (out of scope).
