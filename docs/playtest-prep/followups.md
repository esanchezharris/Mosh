# Playtest-prep — follow-ups (NOT fixed; de-risk-only pass)

Logged on `claude/playtest-prep-0621`, 2026-06-21. Per the de-risk-only mandate, none of
these were changed in code — they're documented with repro + workaround for a later session.

## A. NEW — a joined GUEST hangs on `export_audio`  ⚠️ playtest-relevant

**Symptom:** a process that has **joined** a multiplayer session hangs indefinitely in
`export_audio` (render never returns; output file stays 0 bytes).

**Scoping (measured):**
- export with **no session** → fine.
- export in a **host** (created) session → fine (verified: 265 KB WAV, `renderMode: fast`).
- export in a **joined guest** session → **hangs**.

**Repro:** `scripts/playtest/mp-live-smoke.sh` (earlier export-based variant); minimal =
`mp_join_session` → `__wait` → `export_audio` via `--run-script`.

**Likely area:** the guest's apply/poll path interacting with the synchronous
`Renderer::renderToFile` — possibly a clip left `sourceMissing` from bootstrap, or the MP
background poll vs. the render on the message thread. May be amplified by the headless
`--run-script` manual message pump (the GUI's thread model differs).

**Workaround tonight:** the **host** does any export/bounce; a guest leaves the session
before exporting. **Action:** reproduce in the GUI first (it may not occur there); if real,
fix the render/poll interaction (e.g. ensure sources are resolved or the render doesn't block
the poll). Do NOT ship a rushed fix before the playtest — the workaround is clean.

## B. Pre-existing known limits (from docs/MULTIPLAYER.md) — candidates, not done

- **Bootstrap audio not wired:** a guest joining mid-session sees pre-existing **audio**
  clips as `sourceMissing` until the host re-commits that track. (MIDI appears immediately.)
  Fix = on join, have the host auto re-publish audio-bearing tracks, or fetch missing stems
  by hash from the relay on bootstrap. *Note:* the live smoke shows commits made **after** the
  guest is present DO deliver audio — so the gap is specifically *pre-join* audio.
- **Stem up/download on the message thread:** large audio briefly freezes the UI. Fix = move
  blob I/O to a background thread (`MultiplayerClient::uploadBlob/downloadBlob`).
- **Stale lock badge (~250 ms):** a disconnected peer's lock chip lingers until the relay
  sweeps. Cosmetic; smarter expiry on presence-offline.
- **Buses/groups don't replicate:** only tracks sync. Out of scope for a 2-player jam.

## Verified NOT broken (so nobody re-chases them)
- Core gates green: vitest 423, `--selftest` 893×3, MP selftest local + cloud 912.
- Real audio correct: drums audible, neural A/B diff-RMS 0.485, full loop, **real SA3 pq 6.933**.
- Two-process cloud sync (structure + audio blob round-trip): PASS (`mp-live-smoke.md`).
