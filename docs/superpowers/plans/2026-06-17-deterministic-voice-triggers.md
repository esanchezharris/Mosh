# Deterministic Voice Triggers + Performer Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unambiguous spoken/typed phrases fire DAW actions instantly and locally (no LLM/API), including a hands-free take-recording loop ("put me in" → perform → "keep that take") with takes on separate lanes.

**Architecture:** A pure, state-aware fuzzy phrase matcher (`fastPath.ts`) runs in `AgentComposer.run()` *before* `brain.send()`; on a confident match it executes via the existing `runAgentBatch` → MoshOps path and returns (no API); otherwise it falls through to the LLM unchanged. A small mode FSM (`idle → recording → reviewing`, derived from the live snapshot) gates which phrases are valid. The engine work exposes Tracktion's recording + take-lane capabilities through new MoshOps commands and widens the TS catalog to match the C++ that already exists on main.

**Tech Stack:** TypeScript + React (Vite, vitest, zustand store), JUCE/Tracktion C++ (MoshOps command handlers). Branch `claude/voice-triggers` off `main`.

**Spec:** `docs/superpowers/specs/2026-06-17-deterministic-voice-triggers-design.md`

---

## File structure

| File | Responsibility | New? |
|---|---|---|
| `ui/src/agent/fuzzy.ts` | `tokenSetScore` + `levenshtein` — pure string similarity | create |
| `ui/src/agent/fuzzy.test.ts` | tests for the scorer | create |
| `ui/src/agent/fastPath.ts` | `matchFastPath(text, ctx)` + the rule table + `FastAction` types | create |
| `ui/src/agent/fastPath.test.ts` | matcher behavior, state-gating, anti-false-match, bar extraction | create |
| `ui/src/agent/commands.ts` | widen catalog: action-`set_transport`, `arm_track`, `stop_recording`, `undo`, `redo`, `save`, take commands | modify |
| `ui/src/agent/commands.test.ts` | catalog has the new commands; (contract vs MoshOps if present) | create/modify |
| `ui/src/store.ts` | `record` mode slice: `recordMode`, `takeDecisionPending`, transitions | modify |
| `ui/src/agent/performer.ts` | `handleFast(action, deps)` — turns a FastAction into commands/transitions | create |
| `ui/src/agent/performer.test.ts` | handleFast maps actions → expected command calls | create |
| `ui/src/ui/AgentComposer.tsx` | hook the fast path before `brain.send`; talk-button stops recording | modify |
| `src/moshops/MoshOps.{h,cpp}` | `list_takes`, `set_current_take`, `keep_take` + snapshot take field | modify |

---

## Task 1: `tokenSetScore` (pure fuzzy scorer)

**Files:**
- Create: `ui/src/agent/fuzzy.ts`
- Test: `ui/src/agent/fuzzy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/agent/fuzzy.test.ts
import { describe, it, expect } from "vitest";
import { tokenSetScore, levenshtein } from "./fuzzy";

describe("levenshtein", () => {
  it("is 0 for equal strings and grows with edits", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("tokenSetScore — order-independent, filler/subset tolerant", () => {
  it("scores an exact token set 1", () => {
    expect(tokenSetScore("keep that take", "keep that take")).toBe(1);
  });
  it("scores a phrase whose tokens are a subset of the utterance highly", () => {
    expect(tokenSetScore("okay keep that take", "keep that take")).toBeGreaterThan(0.9);
  });
  it("is token-order independent", () => {
    expect(tokenSetScore("take that keep", "keep that take")).toBeGreaterThan(0.9);
  });
  it("tolerates a one-character STT slip", () => {
    expect(tokenSetScore("keep that takes", "keep that take")).toBeGreaterThan(0.8);
  });
  it("scores unrelated text low", () => {
    expect(tokenSetScore("play the drums louder", "keep that take")).toBeLessThan(0.5);
  });
  it("returns 0 against an empty phrase", () => {
    expect(tokenSetScore("anything", "")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/agent/fuzzy.test.ts` (from `ui/`). Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ui/src/agent/fuzzy.ts
// Pure string similarity for the deterministic phrase matcher — a dependency-free
// port of fuzzywuzzy's token_set_ratio (order-independent, subset-tolerant), using a
// Levenshtein ratio in place of SequenceMatcher. No DOM/node — unit-tested.

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const ratio = (a: string, b: string): number => {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
};

const uniqTokens = (s: string): string[] => [...new Set(s.split(/\s+/).filter(Boolean))];

/** token_set_ratio in [0,1]: high when `phrase`'s tokens are a subset of `utterance`'s,
 *  order-independent and tolerant of extra/filler words. 0 against an empty phrase. */
export function tokenSetScore(utterance: string, phrase: string): number {
  const A = new Set(uniqTokens(utterance));
  const B = new Set(uniqTokens(phrase));
  if (B.size === 0) return 0;
  const inter = [...A].filter((t) => B.has(t)).sort();
  const restA = [...A].filter((t) => !B.has(t)).sort();
  const restB = [...B].filter((t) => !A.has(t)).sort();
  const t0 = inter.join(" ");
  const tA = [...inter, ...restA].join(" ");
  const tB = [...inter, ...restB].join(" ");
  return Math.max(ratio(t0, tA), ratio(t0, tB), ratio(tA, tB));
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/agent/fuzzy.test.ts`. Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add ui/src/agent/fuzzy.ts ui/src/agent/fuzzy.test.ts
git commit -m "feat(voice): pure token-set fuzzy scorer for the phrase matcher"
```

---

## Task 2: `matchFastPath` + the rule table

**Files:**
- Create: `ui/src/agent/fastPath.ts`
- Test: `ui/src/agent/fastPath.test.ts`

Types and contract:

```ts
export type Mode = "idle" | "recording" | "reviewing";
export type FastAction =
  | { kind: "commands"; commands: { command: string; args?: Record<string, unknown> }[]; intent: string; say?: string }
  | { kind: "enterRecord"; bar?: number; intent: string; say?: string }
  | { kind: "stopRecord"; intent: string; say?: string }
  | { kind: "keepTake"; intent: string; say?: string }
  | { kind: "navTake"; delta: 1 | -1; intent: string; say?: string };
export type FastCtx = { mode: Mode; tempo: number; timeSigNum: number };
```

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/agent/fastPath.test.ts
import { describe, it, expect } from "vitest";
import { matchFastPath } from "./fastPath";

const ctx = (mode: "idle" | "recording" | "reviewing" = "idle") => ({ mode, tempo: 120, timeSigNum: 4 });

describe("matchFastPath — global commands (any mode)", () => {
  it("maps 'play it' to a transport toggle", () => {
    const a = matchFastPath("play it", ctx());
    expect(a).toMatchObject({ kind: "commands" });
    expect((a as any).commands[0]).toMatchObject({ command: "set_transport", args: { action: "toggle" } });
  });
  it("maps 'from the top' to to_start", () => {
    expect((matchFastPath("take it from the top", ctx()) as any).commands[0].args.action).toBe("to_start");
  });
  it("maps 'undo' / 'save'", () => {
    expect((matchFastPath("undo that", ctx()) as any).commands[0].command).toBe("undo");
    expect((matchFastPath("save it", ctx()) as any).commands[0].command).toBe("save");
  });
});

describe("matchFastPath — record loop + state gating", () => {
  it("'put me in' enters record from idle", () => {
    expect(matchFastPath("put me in", ctx("idle"))).toMatchObject({ kind: "enterRecord" });
  });
  it("'keep that take' is keepTake only when reviewing", () => {
    expect(matchFastPath("keep that take", ctx("reviewing"))).toMatchObject({ kind: "keepTake" });
    expect(matchFastPath("keep that take", ctx("idle"))).toBeNull();
  });
  it("short 'yeah'/'nah' only resolve when reviewing", () => {
    expect(matchFastPath("yeah", ctx("reviewing"))).toMatchObject({ kind: "keepTake" });
    expect(matchFastPath("nah", ctx("reviewing"))).toMatchObject({ kind: "enterRecord" });
    expect(matchFastPath("yeah", ctx("idle"))).toBeNull();
  });
  it("'next take' / 'previous take' navigate in reviewing", () => {
    expect(matchFastPath("next take", ctx("reviewing"))).toMatchObject({ kind: "navTake", delta: 1 });
    expect(matchFastPath("go back a take", ctx("reviewing"))).toMatchObject({ kind: "navTake", delta: -1 });
  });
});

describe("matchFastPath — parametrized + safety", () => {
  it("extracts a bar number (digit or word)", () => {
    expect(matchFastPath("put me in at bar 8", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
    expect(matchFastPath("put me in at eight", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
  });
  it("falls through (null) on ambiguous / unknown utterances", () => {
    expect(matchFastPath("play the drums and add some reverb", ctx())).toBeNull();
    expect(matchFastPath("make the bass warmer", ctx())).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail.** Run: `npx vitest run src/agent/fastPath.test.ts`. Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `ui/src/agent/fastPath.ts`

```ts
// ui/src/agent/fastPath.ts
// The deterministic, state-aware phrase matcher. Runs BEFORE the LLM: a confident,
// whole-utterance match to a known unambiguous phrase produces a FastAction executed
// locally (no API); anything ambiguous returns null → the LLM brain handles it.
// Adapts the owner's DAWN FSM/fuzzy logic (state-gated rules + token-set fuzzy match).
import { tokenSetScore } from "./fuzzy";

export type Mode = "idle" | "recording" | "reviewing";
export type FastAction =
  | { kind: "commands"; commands: { command: string; args?: Record<string, unknown> }[]; intent: string; say?: string }
  | { kind: "enterRecord"; bar?: number; intent: string; say?: string }
  | { kind: "stopRecord"; intent: string; say?: string }
  | { kind: "keepTake"; intent: string; say?: string }
  | { kind: "navTake"; delta: 1 | -1; intent: string; say?: string };
export type FastCtx = { mode: Mode; tempo: number; timeSigNum: number };

const THRESHOLD = 0.78;
const FILLER = /\b(uh+|um+|like|okay|ok|please|alright|just|so|hey|moshi)\b/g;
const WORD_NUM: Record<string, number> = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,sixteen:16,twenty:20,thirty:30,thirtytwo:32 };

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim();
}

function extractBar(norm: string): number | undefined {
  const m = norm.match(/(?:bar|measure|at|from)\s+([a-z0-9]+)/);
  if (!m) return undefined;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  return WORD_NUM[raw];
}

// A rule: aliases (matched fuzzily) + the modes it's valid in + a builder for the action.
type Rule = { aliases: string[]; modes: Mode[]; build: (norm: string, ctx: FastCtx) => FastAction };
const cmd = (command: string, args: Record<string, unknown>, intent: string, say?: string): FastAction =>
  ({ kind: "commands", commands: [{ command, args }], intent, say });

const RULES: Rule[] = [
  // ── record / take loop ──
  { aliases: ["put me in","come in","lets go","start recording","record","im ready","punch in"], modes: ["idle","reviewing"],
    build: (n) => ({ kind: "enterRecord", bar: extractBar(n), intent: "ACK_WORKING", say: "you're in" }) },
  { aliases: ["put me in at","let me go in at"], modes: ["idle","reviewing"],
    build: (n) => ({ kind: "enterRecord", bar: extractBar(n), intent: "ACK_WORKING", say: "you're in" }) },
  { aliases: ["keep that take","keep that","keep it","keep","save that","thats the one","thats a keeper","thats good","yeah"], modes: ["reviewing"],
    build: () => ({ kind: "keepTake", intent: "DONE", say: "got it" }) },
  { aliases: ["do that again","let me do that again","try that again","again","one more","another take","nah","no"], modes: ["reviewing"],
    build: () => ({ kind: "enterRecord", intent: "ACK_WORKING", say: "again" }) },
  { aliases: ["let me hear that again","play that back","run it back","let me hear that","playback"], modes: ["reviewing"],
    build: () => cmd("set_transport", { action: "to_start" }, "ACK_GOT_IT", "here") },
  { aliases: ["next take","the next one","let me hear the next one"], modes: ["reviewing"],
    build: () => ({ kind: "navTake", delta: 1, intent: "ACK_GOT_IT", say: "next" }) },
  { aliases: ["previous take","go back a take","the one before","last take"], modes: ["reviewing"],
    build: () => ({ kind: "navTake", delta: -1, intent: "ACK_GOT_IT", say: "back" }) },
  // ── transport (global) ──
  { aliases: ["play","play it","play that"], modes: ["idle","reviewing"],
    build: () => cmd("set_transport", { action: "toggle" }, "ACK_GOT_IT") },
  { aliases: ["stop","thats enough","cut","hold on","wait"], modes: ["idle","recording","reviewing"],
    build: (_, ctx) => ctx.mode === "recording" ? { kind: "stopRecord", intent: "ACK_GOT_IT" } : cmd("set_transport", { action: "stop" }, "ACK_GOT_IT") },
  { aliases: ["from the top","take it from the top","back to the start","to the start"], modes: ["idle","reviewing"],
    build: () => cmd("set_transport", { action: "to_start" }, "ACK_GOT_IT") },
  { aliases: ["loop it","turn on looping","loop this"], modes: ["idle","reviewing"],
    build: () => cmd("set_transport", { action: "toggle", loop: true }, "ACK_GOT_IT") },
  // ── history / save (global) ──
  { aliases: ["undo","undo that","scratch that"], modes: ["idle","reviewing"], build: () => cmd("undo", {}, "ACK_GOT_IT") },
  { aliases: ["redo","redo that"], modes: ["idle","reviewing"], build: () => cmd("redo", {}, "ACK_GOT_IT") },
  { aliases: ["save","save it","save the project"], modes: ["idle","reviewing"], build: () => cmd("save", {}, "DONE", "saved") },
];

export function matchFastPath(text: string, ctx: FastCtx): FastAction | null {
  const norm = normalize(text);
  if (!norm) return null;
  let best: { score: number; len: number; rule: Rule } | null = null;
  for (const rule of RULES) {
    if (!rule.modes.includes(ctx.mode)) continue;
    for (const alias of rule.aliases) {
      const a = normalize(alias);
      const exact = norm === a;
      const score = exact ? 1 : tokenSetScore(norm, a);
      if (score < THRESHOLD) continue;
      if (!best || score > best.score || (score === best.score && a.length > best.len)) best = { score, len: a.length, rule };
    }
  }
  return best ? best.rule.build(norm, ctx) : null;
}
```

- [ ] **Step 4: Run, verify pass.** Run: `npx vitest run src/agent/fastPath.test.ts`. Expected: PASS. If "bar 8" extraction or a gating case fails, adjust `extractBar`/aliases (don't loosen `THRESHOLD` below ~0.75).

- [ ] **Step 5: Commit**

```bash
git add ui/src/agent/fastPath.ts ui/src/agent/fastPath.test.ts
git commit -m "feat(voice): state-aware deterministic phrase matcher (fastPath)"
```

---

## Task 3: Widen the TS command catalog to match main's C++

main's C++ already handles these; the TS catalog (`ui/src/agent/commands.ts`) is stale. Add entries with args **verified against `src/moshops/MoshOps.cpp`** (the executor's `validateCommand` must accept what the C++ reads).

**Files:** Modify `ui/src/agent/commands.ts`; Test `ui/src/agent/commands.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/agent/commands.test.ts
import { describe, it, expect } from "vitest";
import { validateCommand, AGENT_COMMAND_MAP } from "./commands";

describe("catalog — performer-mode commands exposed", () => {
  for (const c of ["set_transport","arm_track","stop_recording","undo","redo","save","list_takes","set_current_take","keep_take"])
    it(`has ${c}`, () => expect(AGENT_COMMAND_MAP.has(c)).toBe(true));

  it("set_transport accepts an action string", () => {
    expect(validateCommand("set_transport", { action: "record" })).toBeNull();
  });
  it("arm_track requires trackId + armed:boolean", () => {
    expect(validateCommand("arm_track", { trackId: "t1", armed: true })).toBeNull();
    expect(validateCommand("arm_track", { trackId: "t1" })).not.toBeNull();
  });
  it("keep_take requires clipId", () => {
    expect(validateCommand("keep_take", { clipId: "c1" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail** (`npx vitest run src/agent/commands.test.ts`).

- [ ] **Step 3: First read `src/moshops/MoshOps.cpp`** for each handler's `args.getProperty("…")` calls to copy exact arg names. Then add to `AGENT_COMMANDS` in `commands.ts` (replace the stale `set_transport`):

```ts
  // ── transport / recording / history (handlers exist in main's MoshOps.cpp) ──
  { command: "set_transport", desc: "Transport: play/stop/record/seek", args: [S("action", false, '"play"|"toggle"|"stop"|"record"|"to_start"|"to_end"'), B("loop", false), N("position", false, "seconds")] },
  { command: "arm_track", desc: "Arm/disarm a track's input for recording", args: [S("trackId"), B("armed")] },
  { command: "stop_recording", desc: "Stop recording and land the take", args: [B("discardRecordings", false)] },
  { command: "set_input_monitor", desc: "Set a track's input monitoring", args: [S("trackId"), S("mode", false, '"off"|"automatic"|"on"')] },
  { command: "undo", desc: "Undo the last change", args: [] },
  { command: "redo", desc: "Redo the last undone change", args: [] },
  { command: "save", desc: "Save the session", args: [] },
  // ── takes (NEW C++ in Task 5) ──
  { command: "list_takes", desc: "List the take lanes on a clip", args: [S("clipId")] },
  { command: "set_current_take", desc: "Select which take lane is active", args: [S("clipId"), N("takeIndex")] },
  { command: "keep_take", desc: "Keep the current take lane, remove the rest", args: [S("clipId")] },
```

Add matching `describeCommand` cases (e.g. `case "undo": return "Undid the last change";` … `case "keep_take": return "Kept the take";`).

- [ ] **Step 4: Run, verify pass.** `npx vitest run src/agent/commands.test.ts` → PASS. Also `npm test` (no regressions) + `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/agent/commands.ts ui/src/agent/commands.test.ts
git commit -m "feat(voice): expose transport/record/history + take commands in the TS catalog"
```

---

## Task 4: Mode FSM slice + `handleFast` + the composer hook

**Files:** Modify `ui/src/store.ts` (add a `record` slice); Create `ui/src/agent/performer.ts` + `ui/src/agent/performer.test.ts`; Modify `ui/src/ui/AgentComposer.tsx`.

**Store slice (add to `store.ts` state):** `recordMode: Mode` (`"idle"`), `takeDecisionPending: boolean`, and setters `setRecordMode`, `setTakeDecisionPending`. Derive the effective `Mode` for the matcher: `snapshot.transport.recording ? "recording" : takeDecisionPending ? "reviewing" : "idle"` (expose a `currentMode()` selector).

- [ ] **Step 1: Write the failing test** (`performer.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { handleFast } from "./performer";

const deps = () => {
  const calls: any[] = [];
  return {
    calls,
    runBatch: vi.fn(async (_l: string, cs: any[]) => { calls.push(...cs); }),
    enterRecord: vi.fn(async (_bar?: number) => {}),
    stopRecord: vi.fn(async () => {}),
    keepTake: vi.fn(async () => {}),
    navTake: vi.fn(async (_d: number) => {}),
    utter: vi.fn((_i: string, _s?: string) => {}),
  };
};

describe("handleFast", () => {
  it("runs a commands action via the batch", async () => {
    const d = deps();
    await handleFast({ kind: "commands", commands: [{ command: "undo" }], intent: "ACK_GOT_IT" }, d);
    expect(d.runBatch).toHaveBeenCalledOnce();
    expect(d.calls[0]).toMatchObject({ command: "undo" });
  });
  it("routes record/keep/nav transitions to their handlers + utters", async () => {
    const d = deps();
    await handleFast({ kind: "enterRecord", bar: 8, intent: "ACK_WORKING", say: "in" }, d);
    expect(d.enterRecord).toHaveBeenCalledWith(8);
    await handleFast({ kind: "keepTake", intent: "DONE" }, d);
    expect(d.keepTake).toHaveBeenCalledOnce();
    await handleFast({ kind: "navTake", delta: -1, intent: "ACK_GOT_IT" }, d);
    expect(d.navTake).toHaveBeenCalledWith(-1);
    expect(d.utter).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `performer.ts`** — a pure router from `FastAction` to injected dependency callbacks (so it's testable without the store/bridge):

```ts
import type { FastAction } from "./fastPath";
export type FastDeps = {
  runBatch: (label: string, cmds: { command: string; args?: Record<string, unknown> }[]) => Promise<void>;
  enterRecord: (bar?: number) => Promise<void>;
  stopRecord: () => Promise<void>;
  keepTake: () => Promise<void>;
  navTake: (delta: number) => Promise<void>;
  utter: (intent: string, say?: string) => void;
};
export async function handleFast(a: FastAction, d: FastDeps): Promise<void> {
  d.utter(a.intent, a.say);
  switch (a.kind) {
    case "commands": await d.runBatch(a.say ?? "voice", a.commands); break;
    case "enterRecord": await d.enterRecord(a.bar); break;
    case "stopRecord": await d.stopRecord(); break;
    case "keepTake": await d.keepTake(); break;
    case "navTake": await d.navTake(a.delta); break;
  }
}
```

- [ ] **Step 4: Run performer tests → PASS.**

- [ ] **Step 5: Wire `enterRecord`/`stopRecord`/`keepTake`/`navTake` in the store** (real implementations using `exec`): `enterRecord(bar?)` → arm focused track, optional seek to bar, `exec("set_transport",{action:"record"})`, `setRecordMode` via snapshot; `stopRecord()` → `exec("stop_recording",{})` then `setTakeDecisionPending(true)`; `keepTake()` → `exec("keep_take",{clipId})` + `setTakeDecisionPending(false)`; `navTake(d)` → `exec("set_current_take",…)` + play. Focused-track + focused-clip helpers read the snapshot.

- [ ] **Step 6: Hook `AgentComposer.run()`** ([AgentComposer.tsx](../../../ui/src/ui/AgentComposer.tsx):34). Before `brain.send`:

```ts
const st = useStore.getState();
const fast = matchFastPath(text, { mode: st.currentMode(), tempo: st.snapshot?.session?.tempo ?? 120, timeSigNum: st.snapshot?.session?.timeSigNumerator ?? 4 });
if (fast) { await handleFast(fast, fastDeps()); setAgentBusy(false); return; }
```

And in the mic `onPointerDown` (line ~78): if `useStore.getState().currentMode() === "recording"`, call `stopRecord()` first (don't also start listening until recording is stopped) — the "talk button stops recording" behavior.

- [ ] **Step 7: Run `npm test` + `npm run typecheck` → green. Commit.**

```bash
git add ui/src/store.ts ui/src/agent/performer.ts ui/src/agent/performer.test.ts ui/src/ui/AgentComposer.tsx
git commit -m "feat(voice): mode FSM + handleFast router + fast-path hook in the composer"
```

---

## Task 5: Take-lane C++ commands (resolve the mechanism first)

**Files:** Modify `src/moshops/MoshOps.{h,cpp}`.

- [ ] **Step 1: SPIKE — resolve the take-lane mechanism.** Read the pinned `tracktion_engine` clone for `WaveAudioClip` takes (`getTakes/getNumTakes/setCurrentTake/getTakesTree`), `CompManager` (`flattenTake`), and how loop-recording lands takes; read Mosh's `clipToVar`/arrangement model. Decide: surface Tracktion's take tree as **lanes** in the snapshot, vs record each take to a dedicated take-lane track. Write the decision (2–3 sentences) at the top of the new handlers as a comment. *(Owner directive: separate lanes, not a single stacked clip.)*

- [ ] **Step 2: Snapshot field (failing selftest first).** Extend `clipToVar` (wave clips) with `takes` (array of `{index, description, isCurrent}`), `currentTakeIndex`, `numTakes`. Add a `--selftest` assertion that a clip with ≥2 recorded takes reports them.

- [ ] **Step 3: `list_takes` / `set_current_take` / `keep_take` handlers** following the existing template (e.g. `cmdRemoveClip`): `findClip` → `dynamic_cast<te::WaveAudioClip*>`; `list_takes` read-only; `set_current_take` inside `beginTxn`; `keep_take` flattens to the current take preserving source files (`deleteAllUnusedTakes(false)` or `CompManager::flattenTake(idx, false)`), undoable. Register names in the dispatch + declare in `MoshOps.h`. Match the arg names used in the Task-3 catalog entries.

- [ ] **Step 4: Selftest.** Extend the command-surface selftest: record (or synthesize) ≥2 takes → `list_takes` returns them → `set_current_take{1}` → snapshot `currentTakeIndex==1` → `keep_take` → one take remains, undo restores. Run the project's `Mosh --selftest`; confirm no regressions (3× deterministic per the verification conventions). *(Live capture stays headless-gated; use the synthetic-take path where capture isn't available.)*

- [ ] **Step 5: Commit** (`feat(voice): take-lane MoshOps commands (list/set/keep) + snapshot field`).

---

## Task 6: End-to-end verification

- [ ] **Step 1:** `npm --prefix ui run test` (all green incl. fuzzy/fastPath/performer/commands), `npm run typecheck`, `Mosh --selftest` (incl. the new take assertions).
- [ ] **Step 2:** Run the app (preview or packaged) and exercise the loop where possible: type/say "put me in" → recording; talk-button → stop → reviewing; "let me hear that again"/"next take"/"keep that take". Where live capture is unavailable (headless/CoreAudio), verify the command dispatch + snapshot transitions via the harness and note the gap honestly.
- [ ] **Step 3:** Confirm the fast path makes **no** network/brain call on a matched phrase (e.g. spy `brainChat`/`brain.send` in a test, or observe no proxy hit).
- [ ] **Step 4:** Push branch, open PR **against `main`**.

---

## Notes for the implementer

- **TDD throughout.** Tasks 1, 2, 4 are pure/dependency-injected and fully unit-testable — do those test-first with complete coverage. Task 3 is catalog data (verify args against the C++). Task 5 is the only one needing the C++ build + a spike.
- **Don't loosen the matcher threshold** to force a test green — fix the alias/normalization instead. The anti-false-match test ("play the drums louder" → null) is the guardrail that keeps the LLM in charge of ambiguous input.
- **Zero behavior change when no phrase matches** — `matchFastPath` returns `null` and the existing LLM path runs untouched.
