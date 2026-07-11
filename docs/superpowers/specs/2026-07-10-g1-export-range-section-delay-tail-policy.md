# G1: Export range/section + delay-tail policy

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# G1 — Export range/section + delay-tail policy

**Feasible: yes.** This is a clean, self-contained command-surface + UI change. Everything it needs already exists in the pinned Tracktion `Renderer::Parameters` (a `time` range and an `endAllowance` tail field) and in Mosh's own transport loop state. No `src/state` schema change, no MoshEngine change, no plugin/hosting change, no deploy/CI change. The DAW-conformance harness already has a placeholder that flips from `gap` → `pass` when this lands.

---

## 1. Problem & current behavior

`export_audio` always renders `{0, getLength()}` over **all** tracks with **no tail allowance**. It cannot render a selected section, the loop region, or include reverb/delay decay — violating reality-pack invariants **78** ("Render captures the intended range: full arrangement, selected section, or battle loop") and **81** ("Reverb/delay tails are included or cut according to an explicit tail policy") — see `docs/reality-pack/mosh_daw_reality_model.md:78,81` and the eval rows keyed `("Export", "Render a loop range with delay tail enabled")` (DAW-021/033/045/057/069/081/093/105, P0/P1).

Code anchors (`src/moshops/MoshOps.cpp`, `cmdExportAudio` starts at **7236**):

- **7365** `const double len = juce::jmax (0.1, edit.getLength().inSeconds());` — the reported length is hardcoded to the whole edit.
- **7393** `params.time = { tracktion::TimePosition(), edit.getLength() };` — **the hardcoded full-arrangement range.**
- **7394** `params.tracksToDo = te::toBitSet (te::getAllTracks (edit));` — all tracks (out of scope for G1; range/tail only).
- `params.endAllowance` is **never set** → defaults to `0s` → no tail.
- **7418** `const double editSeconds = edit.getLength().inSeconds();` feeds the render watchdog deadline (**7420**).
- **7458–7472** result envelope (`file/format/bitDepth/sampleRate/bytes/seconds/renderMode*`).

The Tracktion mechanisms that make this trivial (pinned clone `~/Library/Mosh/work/deps/tracktion_engine-src`):

- `tracktion_Renderer.h:64` `TimeRange time;` — the render range.
- `tracktion_Renderer.h:65-67` `TimeDuration endAllowance;` — *"optional tail time for notes to end, delays/reverbs to decay… If the audio level drops to silence in this period, the render will be stopped."* — **this is the delay-tail policy, already built in.**
- `playback/graph/tracktion_NodeRenderContext.cpp:147` renders `time.getLength() + endAllowance` samples; **302–312** stops at `time.getEnd() + endAllowance`, *or early* once magnitude drops below the silence threshold inside the allowance window. So `endAllowance>0` = "let the tail ring out, trim the trailing silence" — exactly invariant 81's "include" policy; `endAllowance==0` = current "cut" policy.

The loop region already exists in Mosh state and is read/written today:
- set: `MoshOps.cpp:2294-2296` (`set_transport` `loopStart`/`loopEnd` → `transport.setLoopRange`).
- surfaced: `MoshOps.cpp:8702-8709` (`transportToVar` → snapshot `transport.loopStart`/`loopEnd`), so the UI already knows the loop bounds.

Built-in **reverb** and **delay** plugins exist (`MoshOps.cpp:133-134`, via `load_builtin`) — used only by the tail tests to produce a real decaying tail.

`export_audio` is **not** in the agent catalog (`ui/src/agent/commands.ts` has zero references) — it is a menu/UI command listed in the multiplayer global/unguarded set (`src/multiplayer/LockManager.cpp:24`). So this is UI-surface work, not agent-surface work.

---

## 2. Proposed design

Add four **optional, additive** args to `export_audio`. Absent → byte-identical to today.

| Arg | Type | Default | Meaning |
|---|---|---|---|
| `range` | `"full"` \| `"loop"` \| `"custom"` | `"full"` | Which span to render. |
| `start`, `end` | number (seconds) | — | Custom span bounds; required when `range=="custom"`. Presence of `start`+`end` also *implies* `range="custom"` for ergonomics. |
| `tail` | `"cut"` \| `"include"` | `"cut"` | Delay/reverb-tail policy. |
| `tailSeconds` | number | `2.0` | Allowance length used when `tail=="include"`; clamped to `[0.05, 30]`. |

**Range resolution** (compute a `TimeRange renderRange` before the device teardown, so validation errors return without freeing the playback context):
- `full` → `{ TimePosition(), edit.getLength() }` (current behavior).
- `loop` → `edit.getTransport().getLoopRange()`; if the loop is empty/degenerate (`length <= ~1ms`), **error** `"range 'loop' requested but no loop region is set"`.
- `custom` → `{ start, end }` in seconds. Clamp both to `[0, editLen]`; require `end - start >= 0.01`, else **error**.

**Tail resolution**: `tail=="include"` → `params.endAllowance = TimeDuration::fromSeconds(clamp(tailSeconds,0.05,30))`; `"cut"` → leave `endAllowance` default `0s`.

**Validation (fail before any teardown/render, mirroring the existing format/depth guards):**
- `range` not in the enum → error.
- `range=="custom"` (explicit or implied) with missing/`end<=start`/out-of-edit bounds → error.
- `range=="loop"` with empty loop → error.
- `tail` not in the enum → error.

**Watchdog deadline (7418-7420):** base it on the *actual* rendered span `renderRange.getLength() + endAllowance` instead of the whole `editSeconds`. The full-edit case is unchanged; sub-ranges get a tighter (still generous) bound. (`editSeconds` is a safe superset, so this is a nicety, not required for correctness.)

**Result envelope additions** (non-breaking): add `range` (resolved keyword), `rangeStart`, `rangeEnd`, `tail`, `endAllowance` (seconds, `0` when cut). **Redefine `seconds` to the rendered content length** `rangeEnd - rangeStart` — for the default full range this equals `edit.getLength()`, so it stays backward-compatible with every existing assertion (which only reads `file/format/bitDepth/sampleRate/bytes`, never `seconds`).

**Non-undoable / logging / scope:** unchanged. `export_audio` stays a read-only-to-the-edit render (`logLine(..., undoable:false)`), stays in the LockManager global set. Loop range is live session/transport state (the UI sets it); a `range:"loop"` export reads it at render time — no new persistence.

---

## 3. Exact files to add/modify

### 3a. `src/moshops/MoshOps.cpp` — `cmdExportAudio` (the only C++ logic change)

**(i) After the format/bit-depth/renderMode validation (~after line 7352), before the teardown at 7360**, resolve + validate range and tail:

```cpp
// ── Export range (invariant 78) ──────────────────────────────────────────
const double editLen = juce::jmax (0.01, edit.getLength().inSeconds());
juce::String rangeKind = args.getProperty ("range", var()).toString().trim().toLowerCase();
const bool hasCustomBounds = args.hasProperty ("start") && args.hasProperty ("end");
if (rangeKind.isEmpty()) rangeKind = hasCustomBounds ? "custom" : "full";
if (rangeKind != "full" && rangeKind != "loop" && rangeKind != "custom")
    return errResult ("export_audio", "range must be 'full', 'loop', or 'custom'");

double rStart = 0.0, rEnd = editLen;
if (rangeKind == "loop")
{
    auto loop = edit.getTransport().getLoopRange();   // transport state, context-independent
    rStart = loop.getStart().inSeconds();
    rEnd   = loop.getEnd().inSeconds();
    if (rEnd - rStart < 0.01)
        return errResult ("export_audio", "range 'loop' requested but no loop region is set");
}
else if (rangeKind == "custom")
{
    if (! hasCustomBounds)
        return errResult ("export_audio", "range 'custom' requires 'start' and 'end' (seconds)");
    rStart = juce::jlimit (0.0, editLen, (double) args.getProperty ("start", 0.0));
    rEnd   = juce::jlimit (0.0, editLen, (double) args.getProperty ("end", editLen));
    if (rEnd - rStart < 0.01)
        return errResult ("export_audio", "export range is empty: end must be > start (within the edit)");
}

// ── Delay-tail policy (invariant 81) ─────────────────────────────────────
const juce::String tailKind = args.getProperty ("tail", "cut").toString().trim().toLowerCase();
if (tailKind != "cut" && tailKind != "include")
    return errResult ("export_audio", "tail must be 'cut' or 'include'");
const double tailSeconds = tailKind == "include"
    ? juce::jlimit (0.05, 30.0, (double) args.getProperty ("tailSeconds", 2.0)) : 0.0;
```

**(ii) Replace line 7393** `params.time = { tracktion::TimePosition(), edit.getLength() };` with:

```cpp
params.time = { tracktion::TimePosition::fromSeconds (rStart),
                tracktion::TimePosition::fromSeconds (rEnd) };
params.endAllowance = tracktion::TimeDuration::fromSeconds (tailSeconds);
```

(`TimeRange` from two `TimePosition`s is the exact idiom used at `MoshOps.cpp:2295`; `TimeDuration::fromSeconds` is used throughout, e.g. `MoshOps.cpp:2164,3448`.)

**(iii) Watchdog (7418-7420):** change the deadline base from `editSeconds` to the render span:

```cpp
const double renderSpan = (rEnd - rStart) + tailSeconds;   // was edit.getLength().inSeconds()
const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, renderSpan * 8000.0 + 60000.0);
```

**(iv) Reported length (7365 / result 7467):** set `len = rEnd - rStart` and add fields in the envelope (7458-7472):

```cpp
data->setProperty ("seconds", rEnd - rStart);   // rendered content length (== editLen for full)
data->setProperty ("range", rangeKind);
data->setProperty ("rangeStart", rStart);
data->setProperty ("rangeEnd", rEnd);
data->setProperty ("tail", tailKind);
data->setProperty ("endAllowance", tailSeconds);
```

No change to `src/moshops/MoshOps.h` (`cmdExportAudio(const juce::var&)` signature is unchanged).

### 3b. `ui/src/ui/ExportControls.tsx` — add Range + Tail controls

Add `range`/`tail`/`tailSeconds`/`start`/`end` local state and two selects. For **Loop region**, read the loop bounds already present in the store snapshot (`transport.loopStart`/`loopEnd` from `transportToVar`); disable the Loop option when `loopEnd - loopStart <= 0`. Pass through to `exec`:

```tsx
const args: Record<string, unknown> = { format, bitDepth, range };
if (range === "custom") { args.start = start; args.end = end; }
if (tail === "include") { args.tail = "include"; args.tailSeconds = tailSeconds; }
const r = await exec("export_audio", args);
```

New controls: a `Range` `<select>` (Full mix / Loop region / Custom), Custom → two numeric inputs, a `Tail` `<select>` (Cut tails / Include tails), Include → a `tailSeconds` numeric input. Add `data-testid`s (`export-range`, `export-tail`, `export-tail-seconds`, `export-start`, `export-end`) for e2e/vitest.

### 3c. `ui/src/types.ts` (~560) — extend `ExportResult`

```ts
export type ExportResult = {
  file: string; format: ExportFormat; bitDepth: number; sampleRate: number;
  bytes: number; renderMode: string;
  range?: "full" | "loop" | "custom"; rangeStart?: number; rangeEnd?: number;
  tail?: "cut" | "include"; endAllowance?: number;
};
```

### 3d. `ui/src/bridge.mock.ts` (~1110) — echo the new fields

Extend the `export_audio` mock so vitest/e2e see a faithful envelope, and make the mock's reported `seconds`/`bytes` reflect the requested range so a UI test can assert a shorter render:

```ts
case "export_audio": {
  const rng = str(args.range, args.start !== undefined && args.end !== undefined ? "custom" : "full");
  const rs = rng === "custom" ? num(args.start, 0) : 0;
  const re = rng === "custom" ? num(args.end, 4) : 4;   // mock edit length
  const tail = str(args.tail, "cut");
  return ok(command, { file: str(args.file) || "/mock/mixdown." + str(args.format,"wav"),
    format: str(args.format,"wav"), bitDepth: num(args.bitDepth,24), sampleRate: num(args.sampleRate,SR),
    bytes: Math.round(794000 * (re - rs) / 4), seconds: re - rs,
    range: rng, rangeStart: rs, rangeEnd: re, tail, endAllowance: tail === "include" ? num(args.tailSeconds,2) : 0,
    renderMode: "offline" });
}
```

`ui/src/menuActions.ts:101-104` (the native-dialog "Export Audio…" path) needs **no change** — omitting the new args yields the full-mix default.

### 3e. `scripts/daw-conformance/conformance.py` — flip the placeholder to a real check

Rewrite `fam_export_range_tail` (**477-481**, currently returns `GAP`/G1) to drive an actual range+tail render and return `PASS`. Regenerate `docs/FEATURE_AUDIT.md` via `scoreboard.py` (wired into `gate.sh`). See §5 for the assertions.

---

## 4. Commands / contracts affected

- **`export_audio`**: four new **optional** args (`range`, `start`, `end`, `tail`, `tailSeconds`) + five new **additive** result fields. Fully backward-compatible; omitting them = today's behavior. `seconds` is redefined to the rendered-range length (== edit length for the default full range, so no existing assertion changes).
- **No new command.** No change to undoability, JSONL logging, or multiplayer scope.
- **Agent catalog (`ui/src/agent/commands.ts`) — unchanged.** `export_audio` isn't an agent command today; keeping it out keeps scope tight. If a future item wants the agent to choose ranges, that's a separate additive catalog entry (would then touch `ui/src/agent/commands.contract.test.ts`). Flag as out-of-scope for G1.

---

## 5. Test plan

**`--selftest` / Catch2 (`src/app/SelfTest.cpp`)** — add a new `section("Export range + tail policy (G1)")` right after the IOX export block (~after line 1924). Headless render works there (the full-loop export at 1863 already renders headless). Concrete assertions on a ~4s test-tone edit:
- Full export: `ok`, `range=="full"`, `rangeStart==0`, `abs(rangeEnd-4) < 0.05`, `seconds≈4`. Capture `bytesFull`.
- Custom `{start:1,end:3}`: `ok`, `range=="custom"`, `rangeStart≈1`, `rangeEnd≈3`, `seconds≈2`, and **`bytesCustom < bytesFull`** (PCM byte count scales with duration — the direct proof of invariant 78).
- Loop export: `set_transport {loopStart:0.5, loopEnd:2.5}` then `export_audio {range:"loop"}` → `rangeStart≈0.5`, `rangeEnd≈2.5`.
- Loop with **no** loop set (fresh edit / zero-length loop): `export_audio {range:"loop"}` → **not ok** (`"no loop region is set"`).
- Invalid enum: `range:"bogus"` → not ok; `tail:"bogus"` → not ok; `custom` with `end<=start` → not ok.
- **Tail policy (invariant 81):** `load_builtin {type:"reverb"}` on the tone track, then export a short custom range twice — `tail:"cut"` vs `tail:"include", tailSeconds:2` — assert `endAllowance==0` vs `≈2`, and **`bytesInclude > bytesCut`** (the ringing reverb adds non-silent trailing samples). This is the in-process proof that the tail is actually captured.
- Determinism: `--selftest` run **×3**, byte-identical check counts. Selftest total rises by the number of added `check(...)` calls (baseline currently ≈1199 post-#283; state the new total = baseline + added, don't hard-pin).

**`verify.py` (`scripts/verify-hardware/verify.py`)** — add `check_export_range_tail(ctx)` (registered in the checks list; `stats()` already returns `duration_s`). Real rendered WAVs, relational (not golden-PCM) assertions so it's robust:
- Full (4s tone) → `1.0 < duration_s < 6.0` (≈4).
- Custom `{start:1,end:3}` → `duration_s ≈ 2` **and** `< full duration`.
- Reverb + `tail:"include"` vs `tail:"cut"` on the same short range → `duration_include > duration_cut` (or `bytes_include > bytes_cut`).
- Determinism: two runs give equal `duration_s`. **Do not add to the golden PCM manifest** (`scripts/verify-hardware/golden/manifest.json`) — keep the assertions relational to avoid brittleness from any reverb-tail float noise.

**`vitest` (`ui/src/ui/ExportControls.test.tsx`, new)** — selecting Range=Custom with start/end passes `{range:"custom",start,end}`; Range=Loop reads the store's `transport.loopStart/loopEnd`; Tail=Include passes `{tail:"include",tailSeconds}`; default selection passes no range/tail keys (byte-for-byte the current call). Assert the mocked `exec` receives the exact arg object.

**`e2e` (Playwright, optional but cheap)** — extend the existing export walkthrough: open the Export popover, pick Custom + Include, click `export-run`, assert the "Exported:" note appears (mock returns ok). Run against the isolated config (`ui/playwright.isolated.config.ts`) per the repo's e2e gotcha.

**Conformance (`scripts/daw-conformance/conformance.py`)** — the rewritten `fam_export_range_tail` drives: create track + tone, `set_transport` loop, `export_audio {range:"loop", tail:"include", tailSeconds:1.5}`, then a `{range:"custom"}` export; PASS if both `ok`, files exist, and `duration_s` matches the requested spans (loop shorter than full, tail-include ≥ tail-cut). Returns `verdict(PASS, "audio", [78, 81], ...)`. Regenerate `docs/FEATURE_AUDIT.md`; the in-scope pass count rises by 1 (G1 leaves the backlog).

**No changes** to `commands.contract.test.ts` (agent surface untouched) or the golden-audio gate.

---

## 6. Risks & seam concerns

**Hard-excluded seams — none are touched:**
- **MoshEngine** — not modified. `cmdExportAudio` already reads `eng.edit()`, `eng.sessionDir()`, and the transport; reading `getTransport().getLoopRange()` is one more read of existing state.
- **`src/state`** — not touched. No new nodes, no format-version bump, no snapshot-schema change. Loop range already lives on the transport and is already in the snapshot (`transportToVar`, 8702-8709). Additive command args carry no persisted state.
- **plugins/hosting** — not touched. Built-in reverb/delay already registered; used only inside tests.
- **deploy / CI** — not touched.

**Correctness risks (all mitigated):**
- *Loop read after teardown:* resolve/validate range **before** `freePlaybackContext()` (§3a-i places it before line 7360). `getLoopRange()` reads transport `CachedValue` state and is context-independent, but doing it up front also means validation errors return without a needless teardown.
- *`endAllowance` disables WAV ACID metadata* (`tracktion_Renderer.cpp:83` only adds ACID info when `endAllowance==0s`). Harmless and arguably correct — a tail-included render is not a clean one-shot loop. Note it; no action needed.
- *Silence-trim inside the allowance:* with `tail:"include"` but no decaying source, the render stops ~immediately after `time.getEnd()` (the first post-end block is silent) — so tail-include ≈ tail-cut when there's nothing ringing. This is *correct*, but it means the definitive tail test **must** include a reverb/delay (covered in §5). Documented so a future engineer doesn't "fix" a non-bug.
- *Out-of-bounds custom range:* clamped to `[0, editLen]` with a min-length guard → never produces an empty/negative render.
- *Determinism:* sub-range and reverb-tail renders are deterministic in Tracktion; verify.py anchors on `duration_s`/bytes (relational), not exact PCM, to stay green across environments.

---

## 7. Acceptance criteria

1. `export_audio` with no new args is **behaviorally identical** to today (full mix, no tail); existing selftest/IOX/PRJ-008/conformance assertions unchanged.
2. `range:"custom"` renders only `[start,end]` — proven by `bytesCustom < bytesFull` (selftest) and `duration_s ≈ end-start < full` (verify.py).
3. `range:"loop"` renders the transport loop region; errors cleanly when no loop is set.
4. Invalid `range`/`tail` enums and empty/custom ranges error **before** any render (no partial file).
5. `tail:"include"` captures the decaying tail — proven by `bytesInclude > bytesCut` with a reverb (selftest) and `duration_include > duration_cut` (verify.py); `endAllowance` echoed in the result.
6. Result envelope reports `range/rangeStart/rangeEnd/tail/endAllowance`; `seconds` = rendered span.
7. UI Export popover exposes Range (Full/Loop/Custom) and Tail (Cut/Include+seconds); Loop disabled when no loop set; vitest asserts exact args.
8. `docs/FEATURE_AUDIT.md` regenerated: `("Export","Render a loop range with delay tail enabled")` moves `gap → pass` (invariants 78, 81).
9. `--selftest` ×3 deterministic; Catch2, verify.py, vitest, e2e, conformance all green.

---

## 8. Size & merge posture

**Size: M.** One meaningfully-changed C++ function (contained, no signature/seam change), one UI form, three test surfaces (selftest/verify.py/vitest), the conformance flip + scoreboard regen. No schema, no engine, no plugin, no deploy work.

**Auto-mergeable via the auto-loop gate (fail-closed), medium-high confidence.** The change is additive and fully covered by mechanical checks (the `bytes`/`duration_s` relational assertions directly encode invariants 78 & 81, and `--selftest ×3` + verify.py + conformance are exactly the auto-loop gate surface). The two spots worth a reviewer's eye — the range-clamping/loop-empty edge cases and the reverb-required tail test — are both pinned by explicit red-provable assertions, so they're gate-caught rather than review-dependent. Recommend running through the auto-loop; the adversarial review step is sufficient human oversight (no need to pre-route to needs-human).
