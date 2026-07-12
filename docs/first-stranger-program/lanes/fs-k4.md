# FS-K4 — Wire the K1 packaging check + BOM enforcement

**Lane:** K (Ship kit) · **Spec:** SPEC.md §5 K1 (packaging check) + §5 K4 (BOM adopt/wire) + §1.11
(no RAVE/anira in distributed builds) + §4 of `docs/DEPENDENCY_BOM.md` (enforcement hooks) ·
**Registered bucket:** owner-merge (backlog `files:["scripts/","run-mosh.sh"]`; `run-mosh.sh` is
build tooling, outside the safe allowlist) · **First-session verdict (2026-07-12): GAP EXISTS —
this is a BUILD plan.**

Backlog row (do not invent a schema; this is the registered one):
`{"id":"FS-K4","lane":"K","title":"Wire the K1 packaging check + BOM enforcement","class":"native",`
`"size":"M","order":35,"files":["scripts/","run-mosh.sh"], … owner-merge}`.

---

## Context

The `docs/DEPENDENCY_BOM.md` research is done and verified (delivered alongside the spec; K4 says
*"Do not re-derive the research"*). What K4 asks for now is **wiring**: turn the BOM's §4 enforcement
hooks into a **scripted, blocking packaging check** on the deploy path, plus a bundled NOTICES
surface, plus the funding thresholds *"recorded where the owner will see them at raise time."* K1's
scope block spells out the same check verbatim (SPEC.md:185–187).

Per §0 (*"Verify the gap before building it"*), the first act was to confirm each acceptance
sub-item is genuinely missing from the current tree, not already shipped by a stale-June note.

### Verification evidence (2026-07-12, current worktree `claude/dev-automation-loops-141f8d`)

| Acceptance sub-item | State | Evidence |
|---|---|---|
| Scripted, blocking packaging check on deploy | ❌ **MISSING** | `run-mosh.sh` `deploy`/`release`/`deploy-anira` cases (lines 401–479) call `build_app → install_app → bundle_service → sign → notarize/dmg`; **no check step anywhere**. `service/scripts/bundle_completeness_test.py` exists but checks *import*-completeness (ModuleNotFoundError class), **not** license/BOM. |
| Assert no RAVE/anira artifacts or weights (§1.11) | ❌ **not asserted** | Default `deploy`/`release` build `macos-arm64-release` (anira OFF) so they are clean *by construction* — but **nothing asserts it**. A regression ships silently: e.g. `deploy-anira` staged then `release`d, or a stray RAVE TorchScript `*.ts` weight dropped into `service/`. `bundle_service` copies `service/transform/` (the RAVE-transform **CLI**) and the whole `recipes/` dir. |
| A NOTICE for every shipping BOM §1 row | ❌ **MISSING** | No NOTICES / acknowledgements / third-party-license file anywhere (`git ls-files` + tree grep: none). |
| "Powered by Stability AI" + "Powered by Tracktion Engine" present | ❌ **MISSING** | Both strings absent from the entire tree (only unrelated hit: an `AgentComposer.tsx` mic-"acknowledgement" comment). Required per BOM §1 (Tracktion free tier + SA3 Community License). |
| Enumerate packaged `service/` payload vs BOM rows | ❌ **MISSING** | `bundle_service` ships a hand-maintained file list + whole-dir whitelist; **nothing maps shipped third-party payload → a BOM §1 row** (the "parked FMS models must not ship" guarantee is currently unenforced). |
| Funding thresholds where owner sees them at raise | ⚠️ **partial** | Thresholds ARE in `DEPENDENCY_BOM.md` §2, but **no fundraise-notes doc references them** — the K4 gate wants *"recorded in the BOM **and** referenced from the fundraise notes."* No such notes exist. |
| BOM merged (K4 gate leg) | ⚠️ **not yet committed** | `docs/DEPENDENCY_BOM.md` is present in the working tree but **untracked** (`git ls-files` empty; the whole `docs/first-stranger-program/` tree is likewise untracked working-tree). Backlog attributes the commit to **FS-000**; FS-K4 only *consumes* it. |

### Verdict: **gapExists = true.** This lane builds the enforcement; it does not re-derive the BOM.

---

## Design (what to build — not implemented here)

The load-bearing insight, so the implementer does not fight the gates:

- **Put the check logic + its hermetic self-test under `service/scripts/`, NOT top-level `scripts/`.**
  `gate.sh run_py_tests` (scripts/auto-loop/gate.sh:144 — **forbidden to edit**) discovers exactly
  `service/**/*_test.py` and `service/scripts/*test*.py`, and only when the diff touches `^(relay|service)/`.
  A test under top-level `scripts/` would be **invisible** to the loop and we may not add it to the
  glob. Siting it next to the existing `service/scripts/bundle_completeness_test.py` (same
  static-parse-of-`run-mosh.sh` precedent) makes it auto-discovered **with zero rulebook edit**, and
  `service/**.py` is in the **safe** allowlist.

Deliverables:

1. **`service/scripts/packaging_check.py`** (NEW) — importable pure functions + a CLI. Three modes:
   - `--emit-notices` → prints a NOTICES body generated **from the BOM §1 table** (single source of
     truth ⇒ no drift): one acknowledgement block per row whose *Ship status* is OK, plus the two
     mandatory "Powered by …" lines. Parses the `## §1` markdown table in `docs/DEPENDENCY_BOM.md`.
   - `--bundle <Mosh.app>` → the **blocking live check**. Exit non-zero (with a precise reason) if
     ANY of: (a) a RAVE/anira **artifact** is present; (b) `Contents/Resources/NOTICES.txt` is
     missing, or lacks a required "Powered by …" line, or lacks a block for any shipping §1 row;
     (c) a shipped third-party payload component has no BOM §1 row (the enumeration).
   - default (no args) → the static payload-vs-BOM enumeration (no bundle needed), reused by the test.
2. **`service/scripts/packaging_check_test.py`** (NEW, auto-discovered) — hermetic, deterministic:
   builds fixture bundle dirs in a tmp dir and asserts a clean bundle PASSes while each poisoned
   variant FAILs (RED-proven): a planted `libanira.2.dylib`; a planted RAVE `*.ts` weight; a NOTICES
   missing "Powered by Stability AI"; a shipped payload dir with no BOM row. Plus a static assertion
   that `--emit-notices` output covers every OK row in the real BOM and both mandatory strings.
3. **`run-mosh.sh`** (EDIT — the blocking wire): in `bundle_service`, emit+stage
   `Contents/Resources/NOTICES.txt` via `packaging_check.py --emit-notices`; at the END of the
   `deploy` and `release` cases, run `packaging_check.py --bundle "$DEST"` **fail-closed** (mirror the
   existing `NSSpeechRecognitionUsageDescription` fail-closed net in `install_app`, run-mosh.sh:233).
4. **`docs/FUNDRAISE_NOTES.md`** (NEW, docs/) — an at-raise checklist that cross-references BOM §2
   (JUCE Pro at ≥$300K, Tracktion Pro 2 at ≥$400K, Pro 3 at >$2M; SA3 $1M is revenue-only), so the
   K4 gate's *"referenced from the fundraise notes"* is literally satisfied. Data lives in the BOM;
   this file just points at it where the owner looks at raise time.

**Critical gotchas the implementer MUST honor (found during verification):**

- **Do NOT scan for the substring `rave`.** `service/recipes/library/owner_*rave*.json` are
  legitimate owner **beat recipes** (the music genre) that DO ship. The check must target RAVE/anira
  **model + runtime artifacts** only: `libanira*.dylib`, `libtorch*`/`libc10*`, TorchScript `*.ts`
  weight files, and a Mach-O that links LibTorch (the `deploy-anira` self-contained build). A naive
  grep would false-fail every distributable bundle.
- **`service/transform/transform_cli.py` + `setup-transform.sh` legitimately ship** — they are
  Mosh's own RAVE-transform CLI; the model `.ts` weights they load live at `~/AI/rave-models` and are
  **never bundled**. Shipping the CLI/setup (Mosh source) is fine; shipping *weights/runtime* is not.
  The payload enumeration is about **third-party** shipped payload (weights, vendored dylibs, venvs),
  not Mosh's own `.py`/`.sh`.
- **`deploy-anira` is the private, non-distributable path** (§1.11/BOM §0 fact 2: in-tree +
  undistributed = no obligation). The **blocking** check gates the *distributable* paths (`deploy`,
  `release`) only; on `deploy-anira` it must NOT hard-fail — run it in warn-only mode or skip, and
  print a loud "NON-DISTRIBUTABLE (anira present)" banner so no one notarizes that bundle.

---

## Gates that ALREADY prove this lane (reuse — do not invent new gate infra)

1. **`gate.sh run_py_tests`** auto-runs **`service/scripts/packaging_check_test.py`** (same discovery
   + static-parse technique as `bundle_completeness_test.py`). Hermetic, no build, deterministic ×3.
   **This is the PRIMARY automated proof.** The diff touches `service/` so the `^(relay|service)/`
   trigger fires.
2. **Live check against a real bundle:** `./run-mosh.sh deploy` (needs no Apple cert — see blockers)
   then confirm the appended `packaging_check.py --bundle /Applications/Mosh.app` exits **0**;
   RED-prove by planting a `libanira.2.dylib` / deleting a NOTICES line → deploy aborts. Manual,
   owner-runnable; the deterministic subset is already covered by (1)'s fixtures.
3. **`Mosh --selftest` ≈1254 ×3 deterministic** (§0 baseline) — **unchanged**: this lane touches no
   C++. Re-run to confirm no regression, do not expect a new count.
4. **vitest ≈874 / e2e 125 / `tsc`** (§0) — **unaffected** by the NOTICES-file approach (no `ui/`
   change). Re-run per §0 to confirm green. Only touched if the optional About-surface link (Deferred)
   is added, which then routes through vitest.
5. **Build recipe (§0):** `cmake --preset macos-arm64-release`
   `-DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache`
   `-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src` —
   to produce the bundle gate (2) checks.

No new gate *machinery* is invented; (1) is the reused, auto-discovered proof and (2) exercises the
same code path against a real bundle.

---

## Files to change

- `service/scripts/packaging_check.py` — NEW. Check logic + `--emit-notices` / `--bundle` CLI. *(safe: `service/**.py`)*
- `service/scripts/packaging_check_test.py` — NEW. Hermetic fixtures, auto-discovered by `run_py_tests`. *(safe)*
- `run-mosh.sh` — EDIT. Emit+stage NOTICES in `bundle_service`; blocking `--bundle` check at end of `deploy`+`release`; warn-only on `deploy-anira`. **← the deliverable that forces owner-merge.**
- `docs/FUNDRAISE_NOTES.md` — NEW. At-raise threshold checklist referencing BOM §2. *(safe: `docs/`)*
- `docs/DEPENDENCY_BOM.md` — present in-tree (untracked); **consumed, not authored**, by this lane; committed by **FS-000** (backlog note). If FS-000 has not landed it when this lane runs, the check's BOM-parse fails-closed — so FS-000 is a soft prerequisite.

---

## §0 rules binding this lane

- **One lane per worktree** — this session writes exactly ONE file (this plan). Implementation is a
  later session in its own worktree; no cross-lane work.
- **MoshOps is the sole mutation seam** — N/A by construction. The packaging check is a *read-only*
  scan of a built bundle + static parse of `run-mosh.sh`/the BOM; it mutates no engine/session state
  and adds no command path. It must never call into MoshOps or the app.
- **Nothing a build reads lives under `~/Documents`** — honored. The check reads only the built
  `Mosh.app` (in `/Applications` or the release `OUTDIR` under `~/Desktop/Mosh-share`, per existing
  `run-mosh.sh`) and repo sources; it writes NOTICES **into the bundle**, not under `~/Documents`. Any
  scratch fixtures use a tmp dir, never `~/Documents`.
- **Info.plist TCC keys intact (`MoshFixInfoPlist`)** — the check is **additive** and runs *after*
  the existing `install_app` fail-closed plist net; it must not reorder or remove that net, only sit
  alongside it. Do not touch the plist-injection path.
- **Do not touch parked threads** — N/A (no `arena/`, SA3-LoRA, FMS-spike, or `PROGRAM_STAGE1` work).
- **Never edit the loop rulebook** — the check is deliberately sited under `service/scripts/` so it is
  discovered by the EXISTING `run_py_tests` glob **without editing `scripts/auto-loop/gate.sh`**
  (which is a hard REJECT). Also touches none of: `CLAUDE.md`, specs 00–06,
  `cmake/Dependencies.cmake` / version pins, `.github/**`.

---

## Merge BUCKET

**owner** — matches the registered backlog bucket. Individually the check logic + its test
(`service/**.py`) and the BOM/fundraise/lane docs (`docs/`) are inside the **safe** allowlist, but the
**load-bearing deliverable edits `run-mosh.sh`** (build tooling, outside `ui/`+`docs/`+`service/**.py`),
so the whole lane routes **owner-merge**. There is no way to make the check *blocking on release*
without touching the deploy script — which is exactly why K4/K1 are owner-gated.

---

## BLOCKED-ON-OWNER

- **Landing FS-K4 itself: NOT blocked.** Lane K is `BLOCKED-ON-OWNER: O1` (Apple Developer
  enrollment) but §5 states *"prep tasks may proceed"* — the packaging check is provable against a
  `./run-mosh.sh deploy` (unsigned, no-cert) bundle today. The auto-discovered hermetic test needs no
  bundle at all.
- **The end-to-end K1 gate is O1-blocked** (mount notarized DMG → clean-account launch, zero
  Gatekeeper overrides). That is **FS-K1's** signing/notarization gate, out of scope for FS-K4 — FS-K4
  only wires the *check* that K1's gate then runs green.
- **O4 is a soft dependency on truthfulness, not on wiring.** The check asserts the "Powered by
  Stability AI" *string is present*; the owner's O4 action (register SA3 commercial use at
  stability.ai; confirm the proxy holds a **commercial** API key) is what makes that notice legally
  *true* and the SA3 ship-status valid. Flag it in the plan; it does not block landing the check.
- **The at-raise §2 execution is the owner's, at raise close** — `docs/FUNDRAISE_NOTES.md` *records*
  the thresholds where the owner will see them; this lane does not (cannot) execute the purchases.
- **FS-000 soft-prereq:** `docs/DEPENDENCY_BOM.md` must be committed (FS-000) for the BOM-parse to
  resolve; the check should fail-closed with a clear "BOM not found / not committed" message if it is
  absent, rather than silently passing.

---

## Deferred (optional, NOT required by the gate)

- **UI About / acknowledgements surface** in `ui/` that renders NOTICES (K1 accepts *"about screen
  **or** bundled NOTICES file"* — the bundled file already satisfies the gate). A small "Licenses"
  link routes through vitest and stays in the safe allowlist; do only if the owner wants an in-app
  surface. Low value for the playtest (the bundled NOTICES.txt is sufficient for compliance).
- **JUCE 8 free-tier splash confirmation** (BOM §5 caveat: JUCE 7 required a splash; whether JUCE 8
  Starter/Indie does was not verified). If confirmed required, it is a *build/branding* change, not a
  packaging-check change — track separately, not in FS-K4.
