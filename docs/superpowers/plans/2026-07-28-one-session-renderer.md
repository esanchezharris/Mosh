# One Session Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped single-shot agent prompt show master state, session key, tempo map and buses, by collapsing the codebase's two session renderers into one — fixing MoshAgentBench `master-trim` (0/10 single, 5/5 loop).

**Architecture:** `richSessionBlock` (loop path) is a strict superset of `compactSnapshot` (single-shot path). Move it verbatim into a new `ui/src/agent/sessionRender.ts`; both prompt builders import it; `compactSnapshot` is deleted. The sha256 prompt pin moves deliberately with a written reason. The Python hand-mirror is synced and, for the first time, guarded by a parity test.

**Tech Stack:** TypeScript, vitest (jsdom env, node builtins available), Python 3.12, tsx.

**Spec:** [docs/superpowers/specs/2026-07-28-one-session-renderer-design.md](../specs/2026-07-28-one-session-renderer-design.md)

## Global Constraints

- Work in the worktree `/Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841`. All paths below are relative to it.
- **The loop path's output must not change by a single byte.** `richSessionBlock` moves verbatim — no cleanups, no renames of its internals, no dropping the `t as { sends?: ... }` cast even though `Track.sends` exists on the real type (`ui/src/types.ts:364`).
- **RED-prove every new guard.** A test that has never been seen to fail is not a guard. Sabotage with an **absolute** path, verify the restore, and `grep -rn SABOTAGE` before any commit. This repo has shipped `return 0; // SABOTAGE` stubs before.
- **Never paste an observed selftest/bench count into a baseline file.** Counts here are environment-dependent.
- Do not touch `LOOP_RULES`, `DEFAULT_RULES`, or the command catalog. Those are separate prompt surfaces with their own consumers.
- Commit after every task. Do not push or open a PR — this plan ends at a measured local branch.

---

### Task 1: Extract the shared renderer (pure refactor, loop path byte-unchanged)

**Files:**
- Create: `ui/src/agent/sessionRender.ts`
- Modify: `ui/src/agent/loop/loopPrompt.ts:36-67` (delete `db` + `richSessionBlock`, import instead)
- Modify: `ui/src/agent/loop/loopPrompt.test.ts:3` (import `renderSession` from the new module)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `renderSession(s: Snapshot): string` from `ui/src/agent/sessionRender.ts` — the single session renderer. Tasks 2 and 3 both depend on this exact name and signature.

- [ ] **Step 1: Symlink node_modules (worktree prerequisite)**

The Vite/esbuild step SIGKILLs in a fresh worktree, so the project convention is to symlink the main checkout's `node_modules` after confirming the lockfiles match. Both were verified identical (`sha1 81328e6e…`) while writing this plan, but re-check — the main checkout may have moved since.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && shasum ui/package-lock.json /Users/emiliosanchez-harris/Mosh/ui/package-lock.json
```

Expected: two identical hashes. If they differ, STOP and run `npm ci` in the worktree instead of symlinking.

```bash
ln -s /Users/emiliosanchez-harris/Mosh/ui/node_modules /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui/node_modules
```

- [ ] **Step 2: Establish the green baseline before touching anything**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npm run typecheck && npm test 2>&1 | tail -20
```

Expected: typecheck clean, all tests pass. **Write the reported test count down** — Task 2 compares against it. If anything is red here, STOP: it is pre-existing and must be understood before proceeding.

- [ ] **Step 3: Create the shared renderer module**

Create `ui/src/agent/sessionRender.ts`. The body of `renderSession` is `richSessionBlock` copied character-for-character from `ui/src/agent/loop/loopPrompt.ts:42-67`, along with its `db` helper from line 36.

```ts
// THE session renderer — the one place a Snapshot becomes prompt text.
//
// There used to be two: brainCore's `compactSnapshot` (single-shot) and this,
// as `richSessionBlock` (loop). The compact one showed no master state, so a
// single-shot model asked to "pull the master down a couple dB" could not see
// that the fader defaults to -3dB and guessed an absolute value that moved it
// UP — MoshAgentBench master-trim scored 0/10 single vs 5/5 loop on the same
// models. The rich renderer was already a strict superset, so unifying is a
// pure gain for the single-shot path and a no-op for the loop path.
//
// MIRRORED IN PYTHON: service/sft/build_add_note_corrective.py::render_session.
// Changing this file without changing that one is caught by
// sessionRender.parity.test.ts. Changing it at all moves the sha256 prompt pin
// in loop/loopPrompt.test.ts — that is deliberate, not an obstacle.

import type { Snapshot } from "../types";

const db = (v: unknown): string => `${typeof v === "number" ? +v.toFixed(1) : 0}dB`;

/** Everything the Phase-A baseline proved the model needs to SEE: master (the
 *  fader defaults to −3dB!), its chain, buses, the tempo map (with the indices
 *  remove_tempo_change takes), the key, and per-track pan/sends. */
export function renderSession(s: Snapshot): string {
  const ses = s.session;
  const lines: string[] = [];
  lines.push(`tempo ${ses?.tempo ?? 120} BPM, ${ses?.timeSigNumerator ?? 4}/${ses?.timeSigDenominator ?? 4}`);
  const map = ses?.tempoMap;
  if (map && map.length > 1)
    lines.push(`tempo map (by index): ${map.map((p, i) => `[${i}] ${p.bpm}bpm@${p.time}s${(p.curve ?? 1) === 1 || (p.curve ?? 1) === -1 ? "" : " ramp"}`).join(", ")}`);
  if (ses?.key) lines.push(`key: ${ses.key.tonic} ${ses.key.mode}`);
  const m = s.master;
  const chain = (m?.plugins ?? []).map((p) => (p as { name?: string }).name ?? "?").join(", ");
  lines.push(`master: ${db(m?.volumeDb)} pan ${m?.pan ?? 0} chain:[${chain || "empty"}]`);
  const buses = s.buses ?? [];
  if (buses.length) lines.push(`buses: ${buses.map((b) => `${b.bus} "${b.name}"`).join(", ")}`);
  const sections = (s.sections ?? []).map((x) => `${x.id} "${x.name}" beats ${x.startBeat}-${x.endBeat}`).join("; ");
  lines.push(`sections: ${sections || "(none)"}`);
  const tracks = (s.tracks ?? [])
    .map((t) => {
      const clips = (t.clips ?? []).map((c) => `"${c.id}":${c.type}@${c.start}s`).join(", ");
      const sends = ((t as { sends?: Array<{ bus: number; db?: number }> }).sends ?? [])
        .map((x) => `bus${x.bus}@${x.db ?? 0}dB`).join(",");
      return `  "${t.id}" "${t.name}" ${t.volumeDb ?? 0}dB${t.pan ? ` pan ${t.pan}` : ""}${t.mute ? " muted" : ""}${t.solo ? " solo" : ""}${sends ? ` sends:[${sends}]` : ""} clips:[${clips}]`;
    })
    .join("\n");
  lines.push("tracks:", tracks || "  (none)");
  return lines.join("\n");
}
```

- [ ] **Step 4: Point loopPrompt at it**

In `ui/src/agent/loop/loopPrompt.ts`, delete the `db` const (line 36) and the whole `richSessionBlock` function including its doc comment (lines 38-67). Add to the imports at the top:

```ts
import { renderSession } from "../sessionRender";
```

Change line 80 from `richSessionBlock(snap)` to `renderSession(snap)`:

```ts
  parts.push(LOOP_RULES, "Current session:", snap ? renderSession(snap) : "(empty session)");
```

Update the module header comment (lines 1-5) — it currently claims the rich session block "lives here, in the loop path only", which this change makes false:

```ts
// The loop's OWN prompt module: the multi-step reply contract and the loop rules.
// The session render itself is NO LONGER loop-only — it moved to
// ../sessionRender.ts and the single-shot path now uses the same one (the
// master/key blind spot that cost master-trim 0/10 single-shot).
```

- [ ] **Step 5: Update the test's import**

In `ui/src/agent/loop/loopPrompt.test.ts` line 3, drop `richSessionBlock` from the loopPrompt import and add the new module. Then replace the one use at line 25.

```ts
import { buildLoopSystemPrompt, renderTaskContext, LOOP_RULES } from "./loopPrompt";
import { renderSession } from "../sessionRender";
```

```ts
describe("renderSession — the Phase-A visibility fix", () => {
  const block = renderSession(SNAP);
```

- [ ] **Step 6: Run the full suite — this refactor's test is that nothing moved**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npm run typecheck && npm test 2>&1 | tail -20
```

Expected: same test count as Step 2, all green — **including the sha256 pin at `loopPrompt.test.ts:146`, which must NOT move in this task.** The pin covers `systemPrompt` (single-shot), which Task 1 has not touched. If the pin moves here, something was edited that shouldn't have been.

- [ ] **Step 7: Commit**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && git add ui/src/agent/sessionRender.ts ui/src/agent/loop/loopPrompt.ts ui/src/agent/loop/loopPrompt.test.ts && git commit -m "refactor(agent): extract richSessionBlock to sessionRender.ts, verbatim

Pure move ahead of unifying the two session renderers. The loop path's output
is byte-unchanged; the single-shot prompt pin does not move in this commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Switch the single-shot path to the shared renderer

**Files:**
- Modify: `ui/src/agent/brainCore.ts:15-29` (delete `compactSnapshot`), `:74` (call `renderSession`)
- Modify: `ui/src/agent/loop/loopPrompt.test.ts:124-147` (behavioural assertions + move the pin)

**Interfaces:**
- Consumes: `renderSession(s: Snapshot): string` from `ui/src/agent/sessionRender.ts` (Task 1).
- Produces: the changed shipped prompt. Task 3's Python mirror and Task 4's corpora both depend on this render shape.

- [ ] **Step 1: Write the failing behavioural assertions**

The moved hash alone proves *something* changed, not that the right thing did. Add assertions on the shipped prompt's actual content. In `ui/src/agent/loop/loopPrompt.test.ts`, inside the `describe("legacy prompt byte-stability pin", ...)` block, add this test **above** the existing hash test.

The fixture is the same one the hash test uses (master `volumeDb: 0`, `pan: 0`, no plugins, key C major, no tempo map, no buses) — hoist it to a `const` shared by both tests if you prefer, but duplicating it inline matches the file's existing style.

```ts
  // The pin below moves whenever the prompt changes at all. THIS test says WHAT
  // the single-shot prompt must contain — the master line whose absence made
  // master-trim unsolvable single-shot, and the key it was also dropping.
  it("the shipped single-shot prompt SHOWS master state and the session key", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const p = systemPrompt(fixture);
    expect(p).toContain("master: 0dB pan 0 chain:[empty]");
    expect(p).toContain("key: C major");
    // and the compact renderer's contract still holds — quoted ids
    expect(p).toContain('"17" "Drums"');
    expect(p).toContain('"101":midi@0s');
  });
```

- [ ] **Step 2: Run it and watch it fail (this is the RED proof)**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/loop/loopPrompt.test.ts -t "SHOWS master state" 2>&1 | tail -25
```

Expected: FAIL on `expect(p).toContain("master: 0dB pan 0 chain:[empty]")` — the shipped prompt has no master line. This failure is the entire justification for the change; do not proceed until you have seen it.

- [ ] **Step 3: Switch brainCore to the shared renderer**

In `ui/src/agent/brainCore.ts`, delete the whole `compactSnapshot` function (lines 15-29). Add to the imports:

```ts
import { renderSession } from "./sessionRender";
```

Change line 74:

```ts
  parts.push(rules, "Current session:", snap ? renderSession(snap) : "(empty session)");
```

Update the doc comment on `buildSystemPrompt` (the line reading `PREAMBLE + catalog + [knowledge] + [memory] + rules + session`) to record that the session render is now shared:

```ts
 *  systemPrompt has always used, with the producer-knowledge block inserted next to
 *  the catalog and the M2 memory block (preferences/patterns/project notes) right
 *  after it. The SESSION block is rendered by the shared ../sessionRender.ts — the
 *  same renderer the loop path uses (unified 2026-07-28; the old compactSnapshot
 *  showed no master state, which made master-trim unsolvable single-shot).
```

- [ ] **Step 4: Run the behavioural test — GREEN**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/loop/loopPrompt.test.ts -t "SHOWS master state" 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5: Read the new hash off the now-failing pin**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/loop/loopPrompt.test.ts -t "hash is unchanged" 2>&1 | tail -25
```

Expected: FAIL, printing both hashes. The **Received** value is the new pin. Copy it exactly.

- [ ] **Step 6: Move the pin, with a written reason and the previous value**

Edit `ui/src/agent/loop/loopPrompt.test.ts:140-146`. Keep the file's established convention: a comment saying what moved it and why, a `Previous pin:` line, then the new hash. Replace the existing comment block and hash with:

```ts
    // Moved 2026-07-28, consciously: the two session renderers were unified. The
    // single-shot path used to render via brainCore's compactSnapshot, which showed
    // NO master state — so a model asked to "pull the master down a couple dB" could
    // not see that the fader defaults to -3dB and guessed an absolute value that
    // graded as moving UP (MoshAgentBench master-trim: 0/10 single, 5/5 loop, same
    // models). Both paths now use ../sessionRender.ts. For THIS fixture the diff is
    // exactly two added lines — "key: C major" and "master: 0dB pan 0 chain:[empty]";
    // richer sessions also gain the tempo map, buses and per-track pan/sends.
    // Previous pin: 70f9a562bf8bf352f618c87d3be169c56a10d1c9c527b0bf9d2f84e446a1748e
    expect(hash).toBe("<PASTE THE RECEIVED HASH FROM STEP 5>");
```

- [ ] **Step 7: Pin the whole rendered block, so "exactly two added lines" is enforced not asserted**

The pin comment claims the diff for this fixture is exactly two lines. Do not leave that as prose — this repo's failure mode is claims that age into lies. Add a test that pins the complete render, in the test added in Step 1:

```ts
    // The FULL rendered block for this fixture. Pinning the whole thing (not just
    // `toContain`) is what makes the pin comment's "exactly two added lines"
    // claim checkable: the old compact render was these same lines minus `key:`
    // and `master:`.
    expect(renderSession(fixture)).toBe(
      [
        "tempo 120 BPM, 4/4",
        "key: C major",
        "master: 0dB pan 0 chain:[empty]",
        "sections: (none)",
        "tracks:",
        '  "17" "Drums" 0dB clips:["101":midi@0s]',
      ].join("\n"),
    );
```

This needs `renderSession` imported in the test file — Task 1 Step 5 already added that import.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/loop/loopPrompt.test.ts 2>&1 | tail -12
```

Expected: all green. If the block pin fails, read the received value — it is the ground truth and the pin comment must be corrected to match it, not the other way round.

- [ ] **Step 8: Full suite**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npm run typecheck && npm test 2>&1 | tail -25
```

Expected: typecheck clean; test count = Step 2 of Task 1 **plus one** (the new behavioural test); all green.

Two nearby tests were checked while planning and should still pass — `brainCore.test.ts` "quotes numeric-looking track and clip ids" (quoted ids are preserved) and `harvest/genTurns.test.ts`'s `firstTrackId` regex `/^\s{2}"([^"]+)"\s+"/m` (the new `master:` line has no leading spaces, so it cannot match first). If either is red, that is a real finding — investigate, do not paper over it.

- [ ] **Step 9: Commit**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && git add ui/src/agent/brainCore.ts ui/src/agent/loop/loopPrompt.test.ts && git commit -m "fix(agent): show master state + key in the single-shot prompt

brainCore's compactSnapshot rendered no master volumeDb/pan/chain, so a
single-shot model could not see that the master fader defaults to -3dB.
'pull the master down a couple dB' became an absolute guess that graded as
moving UP — MoshAgentBench master-trim 0/10 single vs 5/5 loop, same models.

Both prompt paths now render through sessionRender.ts. The sha256 prompt pin
moves deliberately, with the previous value and the reason recorded in the
test. A behavioural assertion sits beside the pin so a moved hash is not the
only evidence the right thing changed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Sync the Python mirror and guard it with a parity test

**Files:**
- Create: `ui/src/agent/sessionRender.parity.test.ts`
- Modify: `service/sft/build_add_note_corrective.py:187-191` (`render_session`), `:22` and `:163-164` (docstring/comment references to `compactSnapshot`)

**Interfaces:**
- Consumes: `renderSession(s: Snapshot): string` (Task 1); the changed render shape (Task 2).
- Produces: `render_session(track_id, track_name, clip_id, tempo=120) -> str` in Python, byte-identical to `renderSession` for the one-track/one-MIDI-clip session shape. Task 4 regenerates a corpus from it.

**Why the test lives in `ui/` and not beside the Python:** drift travels one way. The renderer is TypeScript; the Python is the copy. The cheap gate's Python suite is path-scoped to `service/`, so a guard living there would stay silent for exactly the edit that breaks it — a TypeScript-only renderer change. In `ui/`, vitest runs on that change.

- [ ] **Step 1: Write the failing parity test**

Create `ui/src/agent/sessionRender.parity.test.ts`. The TS fixture omits `master` entirely, which renders `master: 0dB pan 0 chain:[empty]` — matching what the Python's synthetic session implies.

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { renderSession } from "./sessionRender";
import type { Snapshot } from "../types";

// service/sft/build_add_note_corrective.py hand-mirrors renderSession in Python
// (it parses commands.ts for the CATALOG, but hand-copies the session render).
// Its docstring used to say "kept in sync by hand" with nothing enforcing it —
// and it duly fell out of sync. This is the enforcement.
const SFT_DIR = resolve(__dirname, "../../../service/sft");

function pythonRenderSession(trackId: string, trackName: string, clipId: string): string {
  return execFileSync("python3", [
    "-c",
    [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(SFT_DIR)})`,
      "from build_add_note_corrective import render_session",
      `sys.stdout.write(render_session(${JSON.stringify(trackId)}, ${JSON.stringify(trackName)}, ${JSON.stringify(clipId)}))`,
    ].join("\n"),
  ], { encoding: "utf8" });
}

// The session shape the Python builder targets: one track, one MIDI clip at 0s,
// no key, no tempo map, no buses, master at its zero defaults.
const FIXTURE = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
  tracks: [
    { id: "4000", index: 0, name: "Melody", type: "midi", volumeDb: 0, mute: false, solo: false,
      clips: [{ id: "4001", name: "pattern", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
} as unknown as Snapshot;

describe("sessionRender ↔ Python mirror parity", () => {
  it("build_add_note_corrective.py::render_session matches renderSession byte-for-byte", () => {
    expect(pythonRenderSession("4000", "Melody", "4001")).toBe(renderSession(FIXTURE));
  });

  it("the mirrored render actually carries the master line (the fixture is not vacuous)", () => {
    // A parity test between two renderers that both dropped master would pass
    // while the bug was fully present. Pin the content, not just the agreement.
    expect(renderSession(FIXTURE)).toContain("master: 0dB pan 0 chain:[empty]");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/sessionRender.parity.test.ts 2>&1 | tail -25
```

Expected: the first test FAILS — the Python still emits the old compact render with no `master:` line. The second test PASSES already (the TS side was fixed in Task 2), which is what makes the first failure meaningful.

If instead you get `spawnSync python3 ENOENT`, python3 is not on PATH. This test requires it; the repo ships a Python service and CI has it. Fix the environment rather than weakening the test.

- [ ] **Step 3: Sync the Python mirror**

In `service/sft/build_add_note_corrective.py`, replace `render_session` (lines 187-191):

```python
def render_session(track_id: str, track_name: str, clip_id: str, tempo: int = 120) -> str:
    """Mirrors ui/src/agent/sessionRender.ts renderSession() for a one-track,
    one-MIDI-clip session — the shape these add_note-population rows target.

    Byte-parity with the TypeScript is enforced by
    ui/src/agent/sessionRender.parity.test.ts (vitest, shells out to python3).
    The master line is unconditional there, and this fixture has no key, no
    tempo map and no buses, so those lines are absent by construction."""
    track_line = f'  "{track_id}" "{track_name}" 0dB clips:["{clip_id}":midi@0s]'
    return (
        f"tempo {tempo} BPM, 4/4\n"
        "master: 0dB pan 0 chain:[empty]\n"
        "sections: (none)\n"
        f"tracks:\n{track_line}"
    )
```

Then fix the two stale references to the deleted TypeScript function. Line 22 (in the module docstring):

```
segments mirror ui/src/agent/brainCore.ts's PREAMBLE / DEFAULT_RULES and
ui/src/agent/sessionRender.ts's renderSession (the persona/format contract;
the session render's parity is test-enforced, the rest is by hand).
```

And the section comment at lines 163-164:

```python
# ── system-prompt scaffold — mirrors ui/src/agent/brainCore.ts PREAMBLE /
#    DEFAULT_RULES and ui/src/agent/sessionRender.ts renderSession verbatim ────
```

- [ ] **Step 4: Run the parity test — GREEN**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/sessionRender.parity.test.ts 2>&1 | tail -10
```

Expected: both tests PASS.

- [ ] **Step 5: RED-prove the guard from the OTHER direction**

Step 2 proved the test catches a stale Python. Now prove it catches a moved TypeScript — the direction this guard exists for.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && cp ui/src/agent/sessionRender.ts /tmp/sessionRender.SABOTAGE-backup.ts && sed -i '' 's/pan \${m?.pan ?? 0}/pan SABOTAGE\${m?.pan ?? 0}/' ui/src/agent/sessionRender.ts && grep -n SABOTAGE ui/src/agent/sessionRender.ts
```

Expected: grep shows the sabotage present. Then:

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx vitest run src/agent/sessionRender.parity.test.ts 2>&1 | tail -15
```

Expected: FAIL. Now restore with an **absolute** path and verify:

```bash
cp /tmp/sessionRender.SABOTAGE-backup.ts /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui/src/agent/sessionRender.ts && grep -rn SABOTAGE /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui/src /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/service; echo "grep exit: $? (1 = clean)"
```

Expected: no SABOTAGE hits anywhere. Then re-run the test and confirm GREEN again.

- [ ] **Step 6: Full suite + the Python builder's own check**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npm run typecheck && npm test 2>&1 | tail -20
```

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && python3 service/sft/build_add_note_corrective.py --check 2>&1 | tail -10
```

Expected: vitest count = Task 2's plus two; `--check` validates and reports its rows without writing.

- [ ] **Step 7: Commit**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && git add ui/src/agent/sessionRender.parity.test.ts service/sft/build_add_note_corrective.py && git commit -m "test(sft): enforce the Python session-render mirror instead of claiming it

build_add_note_corrective.py hand-copies the session render and its docstring
said 'kept in sync by hand' — with nothing enforcing it. It had duly fallen out
of sync. Sync it and add a vitest parity check that shells out to python3.

The test lives in ui/, not beside the Python: drift travels from the TypeScript
(the source) to the Python (the copy), and the cheap gate's Python suite is
path-scoped to service/, so a guard there would stay silent for exactly the
edit that breaks it. RED-proven in both directions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Regenerate the two deterministic SFT corpora

**Files:**
- Modify (regenerate): `service/sft/add_note_corrective.jsonl`, `service/sft/assist_demonstrations.jsonl`
- Modify: `service/sft/README.md` (staleness note for the hand-curated corpus)

**Interfaces:**
- Consumes: the synced Python `render_session` (Task 3) and `buildSystemPrompt` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Record the pre-change state so the regeneration is checkable**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && wc -l service/sft/add_note_corrective.jsonl service/sft/assist_demonstrations.jsonl service/sft/r5_train_additions.jsonl
```

Expected: 40, 35, 105.

- [ ] **Step 2: Regenerate the Python-built corpus**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && python3 service/sft/build_add_note_corrective.py && git diff --stat service/sft/add_note_corrective.jsonl
```

Expected: 40 rows still, all 40 lines changed (every row's system field gains the master line).

- [ ] **Step 3: Prove the regeneration is deterministic**

The builder's docstring claims "running it twice byte-diffs identical". Verify it rather than trusting it.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && cp service/sft/add_note_corrective.jsonl /tmp/ancorr.first.jsonl && python3 service/sft/build_add_note_corrective.py && diff /tmp/ancorr.first.jsonl service/sft/add_note_corrective.jsonl && echo "DETERMINISTIC"
```

Expected: `DETERMINISTIC`.

- [ ] **Step 4: Regenerate the TypeScript-built corpus**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npx tsx scripts/build_assist_sft.mts 2>&1 | tail -10 && cd .. && git diff --stat service/sft/assist_demonstrations.jsonl
```

Expected: 35 rows still, every row's system field changed. The script self-checks each example through `validateCommand` + `parseReply` before writing; if it reports a validation failure, STOP — that is a real finding about the fixture, not a formatting issue.

- [ ] **Step 5: Confirm the new shape actually landed in the data**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && for f in service/sft/add_note_corrective.jsonl service/sft/assist_demonstrations.jsonl service/sft/r5_train_additions.jsonl; do printf '%s: ' "$f"; python3 -c "
import json,sys
n=sum(1 for l in open(sys.argv[1]) if 'master: ' in json.loads(l)['messages'][0]['content'])
print(f'{n} rows carry a master line')" "$f"; done
```

Expected: 40, 35, **0** — the third is the hand-curated corpus, deliberately untouched.

- [ ] **Step 6: Document the deliberate staleness**

Append to `service/sft/README.md`:

```markdown
## Session-render drift (2026-07-28)

The two session renderers were unified into `ui/src/agent/sessionRender.ts`, so
every system prompt now carries a `master: …` line (plus key/tempo-map/buses
when the session has them). See
`docs/superpowers/specs/2026-07-28-one-session-renderer-design.md`.

- `add_note_corrective.jsonl` and `assist_demonstrations.jsonl` were regenerated
  against the new render. Both builders are deterministic — re-run and byte-diff.
- **`r5_train_additions.jsonl` (105 rows) was NOT regenerated.** It has no
  builder; a hand rewrite of the `system` field would be mechanical but
  unverifiable, which is worse than a file that is known-stale. Its rows carry
  the pre-2026-07-28 render. Regenerate or re-curate it before the next local-seat
  training run — a train/serve prompt-shape mismatch is exactly the class of
  problem the r5 4-bit serve read already cost us.

The shipped cloud seat is unaffected: it reads the prompt live.
```

- [ ] **Step 7: Commit**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && git add service/sft/add_note_corrective.jsonl service/sft/assist_demonstrations.jsonl service/sft/README.md && git commit -m "data(sft): regenerate the two deterministic corpora against the new session render

Both builders are deterministic and were re-run + byte-diffed. The 105-row
r5_train_additions.jsonl has no builder and is left known-stale, documented in
the README rather than hand-rewritten unverifiably.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Correct the docs that now assert a closed blind spot

**Files:**
- Modify: `docs/agent-bench/README.md:67-72` ("Reading results honestly")
- Modify: `docs/agent-bench/BASELINE_2026-07.md:60-75` (§2 Visibility failures)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the bench README's blind-spot bullet**

Replace the `- **compactSnapshot blind spots**: …` bullet (through `…Phase-B harness lane.`) in `docs/agent-bench/README.md` with:

```markdown
- **Session-render blind spots — CLOSED 2026-07-28**: the single-shot prompt
  used to omit buses, the master chain, the tempo map and the key, so
  master/tempo-map failures could be VISIBILITY failures rather than model
  failures. Both prompt paths now render through `ui/src/agent/sessionRender.ts`.
  Historical scoreboards taken before this date are NOT comparable to later ones
  on the `master` and `repair`/tempo-map tasks — check the run date before
  putting two numbers side by side.
```

- [ ] **Step 2: Update the baseline's §2, preserving it as history**

In `docs/agent-bench/BASELINE_2026-07.md`, leave every measured number in §2 exactly as it stands — it is a dated record — and add this note immediately after the section's closing line (`**These depress every model equally and are harness work, not model work**…`):

```markdown
> **Resolved 2026-07-28.** The two session renderers were unified into
> `ui/src/agent/sessionRender.ts`; the single-shot path now sees master state,
> the key, the tempo map and buses. The numbers above stand as the pre-fix
> record. Post-fix measurement:
> `docs/agent-bench/REPORT_2026-07-28-session-render.md`.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && git add docs/agent-bench/README.md docs/agent-bench/BASELINE_2026-07.md && git commit -m "docs(bench): the session-render blind spot is closed

README.md and BASELINE §2 both told the reader to discount master/tempo-map
failures as visibility artifacts. That stopped being true today.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Measure

**Files:**
- Create: `docs/agent-bench/REPORT_2026-07-28-session-render.md`
- Created by the runs (not committed unless small): `ui/src/bench/scoreboard.<tag>.{json,md}` — check where the runner writes them and follow the existing convention for whether scoreboards are committed.

**Interfaces:** none.

**Baseline to beat** (single runner, 10 reps/arm, after the vocabulary fix): **master-glue 10/10 · master-eq-before-comp 8/10 · master-trim 0/10.**

- [ ] **Step 1: One smoke run to confirm the harness is wired before spending 40 runs**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npm run agent-bench -- --claude-cli --model claude-sonnet-5 --runner single --tasks master-trim --tag sr-smoke --no-render --bin /Users/emiliosanchez-harris/Mosh/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh 2>&1 | tail -30
```

Expected: the task runs to a verdict. A pass here is encouraging but proves nothing — n=1 on a binary task.

- [ ] **Step 2: The primary measurement — 10 reps, distinct tag each**

**Every repetition needs a DISTINCT `--tag`.** The bench derives its engine session dirs from the tag (`ab-<tag>-<task>-s<step>`); a reused tag makes runs clobber each other's artifacts mid-run. Run them **serially** — concurrent real-engine runs on one machine contend for the same `~/Library/Mosh` state.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && for i in 1 2 3 4 5 6 7 8 9 10; do echo "=== rep $i ==="; npm run agent-bench -- --claude-cli --model claude-sonnet-5 --runner single --tasks master-glue,master-eq-before-comp,master-trim --tag sr-master-r$i --no-render --bin /Users/emiliosanchez-harris/Mosh/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh 2>&1 | tail -12; done
```

- [ ] **Step 3: The regression sweep — 3 full-suite reps, distinct tags**

The single-shot prompt changed for **every** task, not just the three. This sweep is what makes a regression visible at all.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && for i in 1 2 3; do echo "=== full rep $i ==="; npm run agent-bench -- --claude-cli --model claude-sonnet-5 --runner single --tag sr-full-r$i --no-render --bin /Users/emiliosanchez-harris/Mosh/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh 2>&1 | tail -20; done
```

- [ ] **Step 4: Write the report, honestly**

Create `docs/agent-bench/REPORT_2026-07-28-session-render.md`. It must contain:

- The change measured, and the exact commands + tags used.
- **Primary result**: per-task pass counts out of 10, against the stated baseline (10/10 · 8/10 · 0/10). Report what happened, including if master-trim did not go to 10/10.
- **Regression sweep**: per-category totals across the 3 full runs, versus whatever prior full-suite single-runner numbers exist for comparison.
- **An explicit statement of the sweep's low power**: 3 reps on 31 binary tasks cannot resolve a small per-task shift. Say so plainly. Do not write anything that implies the suite is cleared.
- Any task that changed verdict in either direction, named individually.
- The environment: model seat, binary path and its build date, `--no-render`.

- [ ] **Step 5: Final full gate, then commit**

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841/ui && npm run typecheck && npm test 2>&1 | tail -20
```

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && grep -rn SABOTAGE ui/src service docs; echo "grep exit: $? (1 = clean)"
```

Expected: green suite; zero SABOTAGE hits.

```bash
cd /Users/emiliosanchez-harris/Mosh/.claude/worktrees/funny-borg-be3841 && git add docs/agent-bench/REPORT_2026-07-28-session-render.md && git commit -m "docs(bench): post-fix measurement of the unified session renderer

10 reps on the three master tasks + a 3-rep full-suite regression sweep,
distinct tag per rep. Reports the sweep's limited power rather than implying
the suite is cleared.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §3.1 shared module → Task 1. §3.2 pin + behavioural assertion → Task 2. §3.3 Python sync + parity test → Task 3. §3.4 corpora → Task 4. §3.5 docs → Task 5. §4 verification → distributed as RED-proof steps in Tasks 2, 3 and the final gate in Task 6. §5 measurement → Task 6. §6 out-of-scope → Global Constraints. No gaps.

**Placeholder scan:** one intentional fill-in — the new sha256 hash in Task 2 Step 6, which cannot be known before the code runs; Step 5 gives the exact command that produces it. Everything else is literal.

**Type consistency:** `renderSession(s: Snapshot): string` is used identically in Tasks 1, 2 and 3. Python `render_session(track_id, track_name, clip_id, tempo=120)` keeps its existing signature — only the body changes, so `build_system_prompt`'s call site at line 200 needs no edit.
