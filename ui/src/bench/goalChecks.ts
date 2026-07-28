// MoshAgentBench + Moshi-Bench shared grading. `grade()` moved here VERBATIM
// from ui/scripts/moshiBench.mts (same defaults, same notes) so the single-turn
// bench, the multi-step agent bench and vitest all grade through one function —
// then EXTENDED with the multi-step goal predicates (master chain, tempo map,
// key membership, time-range emptiness, net level deltas, …).
//
// Grading philosophy (unchanged): STATE over text; direction + tolerance bands
// for relative asks; defer = a genuine zero-command reply, never a vacuous pass.

import type { Snapshot } from "../types";
import type { Check } from "./cases";
import { NOTE_PC, SCALES, isMode, pitchClass, type Mode } from "../musicalKey";
import type { AgentTaskRun } from "../agent/loopSeam";

export type GoalCheck =
  | Check
  | { kind: "midiNoteCount"; track: string; min: number }
  | { kind: "notesInKey"; track: string; tonic: string; mode: Mode; minNotes: number; requireAll?: boolean }
  | { kind: "timeRangeEmpty"; startSec: number; endSec: number; track?: string }
  | { kind: "tempoMapPoint"; time: number; bpm?: number; tolTime?: number; tolBpm?: number; negate?: boolean }
  | { kind: "masterChainContains"; nameIncludes: string; negate?: boolean }
  | { kind: "masterChainOrder"; first: string; then: string }
  | { kind: "masterDelta"; field: "volumeDb"; dir: "down" | "up"; min: number; max: number }
  | { kind: "sendExists"; track: string; negate?: boolean }
  | { kind: "busCountDelta"; delta: number }
  | { kind: "clipField"; track: string; clipIndex: number;
      field: "gainDb" | "length" | "start" | "loopEnabled" | "reversed" | "fadeInSec" | "fadeOutSec" | "hasRenderLayer" | "mute";
      eq?: unknown; min?: number; max?: number; tol?: number }
  | { kind: "cmdOkAny"; names: string[]; min: number }
  | { kind: "netTrackLevelDelta"; track: string; dir: "down" | "up"; minDb: number; maxDb?: number }
  | { kind: "sessionKey"; tonic: string; mode: string }
  | ConversationalCheck;

/** Goals about behaviour ACROSS user turns, for the conversational categories.
 *  Unlike every other check these read the TRANSCRIPT, not the snapshot — state
 *  alone cannot distinguish "asked first, then acted" from "acted immediately",
 *  and that distinction is the whole point of those tasks. Graded by
 *  `gradeConversational` (scoreTask routes them); `grade()` never sees them, so
 *  the moshi-bench single-turn caller is untouched. */
export type ConversationalCheck =
  /** Turn `turn` emitted ZERO commands and said something — it responded with
   *  words instead of actions. NB: we do not verify the words form a question;
   *  that needs a judge, the same limit the scripted follow-ups carry. */
  | { kind: "askedAtTurn"; turn: number }
  /** Turn `turn` landed at least one SUCCESSFUL command. */
  | { kind: "actedAtTurn"; turn: number }
  /** Nothing was mutated before turn `turn`. This is what makes "ask first" mean
   *  something: without it an agent that acts AND asks scores like one that
   *  waited, and the acting is exactly the behaviour the task is testing for. */
  | { kind: "noCommandsBeforeTurn"; turn: number };

const CONVERSATIONAL_KINDS = new Set(["askedAtTurn", "actedAtTurn", "noCommandsBeforeTurn"]);
export const isConversationalCheck = (c: GoalCheck): c is ConversationalCheck =>
  CONVERSATIONAL_KINDS.has((c as { kind: string }).kind);

export type CheckResult = { check: GoalCheck; pass: boolean; note: string };
export type CmdResult = { command: string; ok: boolean };

type Tracks = Array<Record<string, unknown>>;
const tracksOf = (s: Snapshot): Tracks => ((s as any).tracks ?? []) as Tracks;
const findTrack = (s: Snapshot, name: string) => {
  const ts = tracksOf(s);
  return ts.find((t) => t.name === name) ?? ts.find((t) => String(t.name ?? "").toLowerCase().includes(name.toLowerCase()));
};
const num = (v: unknown): number => (typeof v === "number" ? v : NaN);
const clipsOf = (t: Record<string, unknown> | undefined): Array<Record<string, unknown>> =>
  (((t as any)?.clips ?? []) as Array<Record<string, unknown>>);
const notesOfTrack = (t: Record<string, unknown> | undefined): Array<Record<string, unknown>> =>
  clipsOf(t).flatMap((c) => ((c.notes ?? []) as Array<Record<string, unknown>>));

export function grade(check: GoalCheck, before: Snapshot, after: Snapshot, cmdResults: CmdResult[]): CheckResult {
  const fail = (note: string): CheckResult => ({ check, pass: false, note });
  const pass = (note: string): CheckResult => ({ check, pass: true, note });
  const sesA = (after as any).session ?? {};
  switch (check.kind) {
    case "tempo": {
      const t = num(sesA.tempo);
      if (check.eq !== undefined) return Math.abs(t - check.eq) <= (check.tol ?? 0.01) ? pass(`tempo ${t}`) : fail(`tempo ${t} ≠ ${check.eq}`);
      if (check.min !== undefined && t < check.min) return fail(`tempo ${t} < ${check.min}`);
      if (check.max !== undefined && t > check.max) return fail(`tempo ${t} > ${check.max}`);
      return pass(`tempo ${t}`);
    }
    case "timeSig": {
      const n = num(sesA.timeSigNumerator), d = num(sesA.timeSigDenominator);
      return n === check.num && d === check.den ? pass(`${n}/${d}`) : fail(`${n}/${d} ≠ ${check.num}/${check.den}`);
    }
    case "trackCount": {
      const delta = tracksOf(after).length - tracksOf(before).length;
      return delta === check.delta ? pass(`Δtracks ${delta}`) : fail(`Δtracks ${delta} ≠ ${check.delta}`);
    }
    case "trackExists": {
      const found = !!findTrack(after, check.name);
      return found !== !!check.negate ? pass(`"${check.name}" ${found ? "exists" : "absent"}`) : fail(`"${check.name}" ${found ? "unexpectedly exists" : "missing"}`);
    }
    case "trackField": {
      const t = findTrack(after, check.track);
      if (!t) return fail(`track "${check.track}" not found`);
      const v = (t as any)[check.field];
      if (check.eq !== undefined) {
        if (typeof check.eq === "number") return Math.abs(num(v) - check.eq) <= (check.tol ?? 0.25) ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
        return v === check.eq ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
      }
      if (check.min !== undefined && num(v) < check.min) return fail(`${check.field}=${v} < ${check.min}`);
      if (check.max !== undefined && num(v) > check.max) return fail(`${check.field}=${v} > ${check.max}`);
      return pass(`${check.field}=${v}`);
    }
    case "trackDelta": {
      const tb = findTrack(before, check.track), ta = findTrack(after, check.track);
      if (!tb || !ta) return fail(`track "${check.track}" not found`);
      const d = num((ta as any)[check.field]) - num((tb as any)[check.field]);
      const signed = check.dir === "down" ? -d : d;
      return signed >= check.min && signed <= check.max
        ? pass(`${check.field} moved ${check.dir} ${Math.abs(d).toFixed(1)}`)
        : fail(`${check.field} Δ${d.toFixed(1)} not ${check.dir} within [${check.min},${check.max}]`);
    }
    case "clipCount": {
      const tb = findTrack(before, check.track), ta = findTrack(after, check.track);
      if (!ta) return fail(`track "${check.track}" not found`);
      const d = clipsOf(ta).length - clipsOf(tb).length;
      return d === check.delta ? pass(`Δclips ${d}`) : fail(`Δclips ${d} ≠ ${check.delta}`);
    }
    case "clipStart": {
      const ta = findTrack(after, check.track);
      const clip = clipsOf(ta)[check.clipIndex];
      if (!clip) return fail(`clip[${check.clipIndex}] on "${check.track}" not found`);
      const s = num(clip.start);
      return s >= check.minSec && s <= check.maxSec ? pass(`start ${s}s`) : fail(`start ${s}s ∉ [${check.minSec},${check.maxSec}]`);
    }
    case "transport": {
      const v = ((after as any).transport ?? {})[check.field];
      return v === check.eq ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
    }
    case "transportPos": {
      const p = num(((after as any).transport ?? {}).position);
      return p >= check.minSec && p <= check.maxSec ? pass(`pos ${p}s`) : fail(`pos ${p}s ∉ [${check.minSec},${check.maxSec}]`);
    }
    case "sectionExists": {
      const secs = ((after as any).sections ?? []) as Array<Record<string, unknown>>;
      const hit = secs.find((x) => String(x.name ?? "").toLowerCase() === check.name.toLowerCase());
      if (check.negate) return hit ? fail(`section "${check.name}" unexpectedly exists`) : pass(`section "${check.name}" absent`);
      if (!hit) return fail(`section "${check.name}" missing (have: ${secs.map((x) => x.name).join(",") || "none"})`);
      const tol = check.tolBeats ?? 1;
      if (check.startBeat !== undefined && Math.abs(num(hit.startBeat) - check.startBeat) > tol) return fail(`startBeat ${hit.startBeat}`);
      if (check.endBeat !== undefined && Math.abs(num(hit.endBeat) - check.endBeat) > tol) return fail(`endBeat ${hit.endBeat}`);
      return pass(`section "${check.name}" ok`);
    }
    case "pluginOnTrack": {
      const ta = findTrack(after, check.track);
      if (!ta) return fail(`track "${check.track}" not found`);
      const blob = JSON.stringify((ta as any).plugins ?? []).toLowerCase();
      const found = blob.includes(check.nameIncludes.toLowerCase());
      return found !== !!check.negate ? pass(`plugin ~"${check.nameIncludes}" ${found ? "present" : "absent"}`) : fail(`plugin ~"${check.nameIncludes}" ${found ? "unexpectedly present" : "missing"}`);
    }
    case "cmdOk": {
      const n = cmdResults.filter((c) => c.command === check.name && c.ok).length;
      return n >= check.min ? pass(`${check.name} ×${n}`) : fail(`${check.name} ×${n} < ${check.min}`);
    }
    case "defer":
      // A defer passes only on a GENUINE deferral — a parseable reply that chose to emit
      // zero commands. Invalid-only output (the model TRIED to act and failed validation)
      // and brain errors are failures, not deferrals (2026-07 audit: vacuous-pass hole
      // inflated local-base by one case).
      return cmdResults.length === 0 ? pass("deferred") : fail(`emitted ${cmdResults.length} command(s) on a defer case`);

    // ── multi-step goal predicates (MoshAgentBench) ────────────────────────────
    case "midiNoteCount": {
      const notes = notesOfTrack(findTrack(after, check.track));
      return notes.length >= check.min ? pass(`${notes.length} notes`) : fail(`${notes.length} notes < ${check.min}`);
    }
    case "notesInKey": {
      const t = findTrack(after, check.track);
      if (!t) return fail(`track "${check.track}" not found`);
      const tonicPc = NOTE_PC[check.tonic];
      if (tonicPc === undefined || !isMode(check.mode)) return fail(`bad key spec ${check.tonic} ${check.mode}`);
      const scale = new Set(SCALES[check.mode]);
      const notes = notesOfTrack(t);
      const inKey = notes.filter((n) => scale.has((pitchClass(num(n.pitch)) - tonicPc + 12) % 12));
      if (check.requireAll && inKey.length !== notes.length)
        return fail(`${notes.length - inKey.length} note(s) out of ${check.tonic} ${check.mode}`);
      return inKey.length >= check.minNotes
        ? pass(`${inKey.length}/${notes.length} in ${check.tonic} ${check.mode}`)
        : fail(`${inKey.length} in-key notes < ${check.minNotes}`);
    }
    case "timeRangeEmpty": {
      const EPS = 1e-3;
      const targets = check.track ? [findTrack(after, check.track)].filter(Boolean) : tracksOf(after);
      for (const t of targets)
        for (const c of clipsOf(t as Record<string, unknown>)) {
          const c0 = num(c.start), c1 = c0 + num(c.length);
          if (c0 < check.endSec - EPS && c1 > check.startSec + EPS)
            return fail(`clip [${c0.toFixed(2)},${c1.toFixed(2)}] on "${(t as any).name}" overlaps [${check.startSec},${check.endSec}]`);
        }
      return pass(`range [${check.startSec},${check.endSec}] empty`);
    }
    case "tempoMapPoint": {
      const map = (sesA.tempoMap ?? []) as Array<Record<string, unknown>>;
      const tolT = check.tolTime ?? 0.05, tolB = check.tolBpm ?? 1;
      const hit = map.find((p) =>
        Math.abs(num(p.time) - check.time) <= tolT &&
        (check.bpm === undefined || Math.abs(num(p.bpm) - check.bpm) <= tolB));
      if (check.negate) return hit ? fail(`tempo point at ${check.time}s unexpectedly present`) : pass(`no tempo point at ${check.time}s`);
      return hit ? pass(`tempo point ${hit.bpm} @ ${hit.time}s`) : fail(`no tempo point at ${check.time}s${check.bpm !== undefined ? ` / ${check.bpm}bpm` : ""} (map: ${map.map((p) => `${p.bpm}@${p.time}`).join(",")})`);
    }
    case "masterChainContains": {
      const plugins = (((after as any).master ?? {}).plugins ?? []) as Array<Record<string, unknown>>;
      const found = plugins.some((p) => JSON.stringify(p).toLowerCase().includes(check.nameIncludes.toLowerCase()));
      return found !== !!check.negate
        ? pass(`master ~"${check.nameIncludes}" ${found ? "present" : "absent"}`)
        : fail(`master ~"${check.nameIncludes}" ${found ? "unexpectedly present" : "missing"} (chain: ${plugins.map((p) => p.name).join(",") || "empty"})`);
    }
    case "masterChainOrder": {
      const plugins = (((after as any).master ?? {}).plugins ?? []) as Array<Record<string, unknown>>;
      const idx = (needle: string) => plugins.findIndex((p) => JSON.stringify(p).toLowerCase().includes(needle.toLowerCase()));
      const a = idx(check.first), b = idx(check.then);
      if (a < 0 || b < 0) return fail(`master chain missing "${a < 0 ? check.first : check.then}"`);
      return a < b ? pass(`"${check.first}" before "${check.then}"`) : fail(`"${check.first}" (idx ${a}) not before "${check.then}" (idx ${b})`);
    }
    case "masterDelta": {
      const d = num(((after as any).master ?? {})[check.field]) - num(((before as any).master ?? {})[check.field]);
      const signed = check.dir === "down" ? -d : d;
      return signed >= check.min && signed <= check.max
        ? pass(`master ${check.field} moved ${check.dir} ${Math.abs(d).toFixed(1)}`)
        : fail(`master ${check.field} Δ${d.toFixed(1)} not ${check.dir} within [${check.min},${check.max}]`);
    }
    case "sendExists": {
      const t = findTrack(after, check.track);
      if (!t) return fail(`track "${check.track}" not found`);
      const sends = ((t as any).sends ?? []) as unknown[];
      const found = sends.length > 0;
      return found !== !!check.negate
        ? pass(`"${check.track}" ${found ? "has a send" : "has no sends"}`)
        : fail(`"${check.track}" ${found ? "unexpectedly has a send" : "has no sends"}`);
    }
    case "busCountDelta": {
      const d = (((after as any).buses ?? []) as unknown[]).length - (((before as any).buses ?? []) as unknown[]).length;
      return d === check.delta ? pass(`Δbuses ${d}`) : fail(`Δbuses ${d} ≠ ${check.delta}`);
    }
    case "clipField": {
      const clip = clipsOf(findTrack(after, check.track))[check.clipIndex];
      if (!clip) return fail(`clip[${check.clipIndex}] on "${check.track}" not found`);
      const v = clip[check.field];
      if (check.eq !== undefined) {
        if (typeof check.eq === "number") return Math.abs(num(v) - check.eq) <= (check.tol ?? 0.25) ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
        return (v ?? false) === check.eq ? pass(`${check.field}=${v}`) : fail(`${check.field}=${v} ≠ ${check.eq}`);
      }
      if (check.min !== undefined && num(v) < check.min) return fail(`${check.field}=${v} < ${check.min}`);
      if (check.max !== undefined && num(v) > check.max) return fail(`${check.field}=${v} > ${check.max}`);
      return pass(`${check.field}=${v}`);
    }
    case "cmdOkAny": {
      const n = cmdResults.filter((c) => check.names.includes(c.command) && c.ok).length;
      return n >= check.min ? pass(`${check.names.join("|")} ×${n}`) : fail(`${check.names.join("|")} ×${n} < ${check.min}`);
    }
    case "netTrackLevelDelta": {
      const tb = findTrack(before, check.track), ta = findTrack(after, check.track);
      if (!tb || !ta) return fail(`track "${check.track}" not found`);
      const meanGain = (t: Record<string, unknown>) => {
        const gains = clipsOf(t).map((c) => num(c.gainDb)).filter((g) => !Number.isNaN(g));
        return gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
      };
      const d = (num((ta as any).volumeDb) - num((tb as any).volumeDb)) + (meanGain(ta) - meanGain(tb));
      const signed = check.dir === "down" ? -d : d;
      const ok = signed >= check.minDb && (check.maxDb === undefined || signed <= check.maxDb);
      return ok
        ? pass(`net level moved ${check.dir} ${Math.abs(d).toFixed(1)} dB`)
        : fail(`net level Δ${d.toFixed(1)} dB not ${check.dir} ≥ ${check.minDb}`);
    }
    case "sessionKey": {
      const k = (sesA.key ?? {}) as Record<string, unknown>;
      const ok = String(k.tonic ?? "").toLowerCase() === check.tonic.toLowerCase()
        && String(k.mode ?? "").toLowerCase() === check.mode.toLowerCase();
      return ok ? pass(`key ${k.tonic} ${k.mode}`) : fail(`key ${k.tonic ?? "?"} ${k.mode ?? "?"} ≠ ${check.tonic} ${check.mode}`);
    }
    // Conversational checks need the transcript, which grade() does not receive.
    // scoreTask routes them to gradeConversational; reaching here means a caller
    // graded one directly. FAIL loudly rather than returning undefined — a check
    // that silently vanished would read on a scoreboard as a check that passed.
    case "askedAtTurn":
    case "actedAtTurn":
    case "noCommandsBeforeTurn":
      return fail(`${check.kind} is a conversational check — grade via scoreTask/gradeConversational`);
  }
}

// ── conversational grading (transcript, not snapshot) ─────────────────────────

/** Steps belonging to one user turn. Steps carry `turn` only on conversational
 *  runs; a single-turn run's steps are all implicitly turn 0. */
const stepsOfTurn = (run: AgentTaskRun, turn: number) =>
  run.transcript.filter((s) => (s.turn ?? 0) === turn);

export function gradeConversational(check: ConversationalCheck, run: AgentTaskRun): CheckResult {
  const fail = (note: string): CheckResult => ({ check, pass: false, note });
  const pass = (note: string): CheckResult => ({ check, pass: true, note });

  switch (check.kind) {
    case "askedAtTurn": {
      const steps = stepsOfTurn(run, check.turn);
      if (steps.length === 0) return fail(`turn ${check.turn} never ran`);
      const emitted = steps.reduce((n, s) => n + s.commands.length, 0);
      if (emitted > 0) return fail(`turn ${check.turn} acted (${emitted} command(s)) instead of asking`);
      const said = steps.some((s) => (s.say ?? "").trim().length > 0);
      return said ? pass(`turn ${check.turn} asked`) : fail(`turn ${check.turn} emitted nothing and said nothing`);
    }
    case "actedAtTurn": {
      const steps = stepsOfTurn(run, check.turn);
      if (steps.length === 0) return fail(`turn ${check.turn} never ran`);
      const ok = steps.reduce((n, s) => n + s.results.filter((r) => r.ok).length, 0);
      return ok > 0 ? pass(`turn ${check.turn} landed ${ok} command(s)`) : fail(`turn ${check.turn} landed nothing`);
    }
    case "noCommandsBeforeTurn": {
      const early = run.transcript
        .filter((s) => (s.turn ?? 0) < check.turn)
        .reduce((n, s) => n + s.commands.length, 0);
      return early === 0
        ? pass(`nothing touched before turn ${check.turn}`)
        : fail(`${early} command(s) emitted before turn ${check.turn}`);
    }
  }
}

// ── task-level scoring ─────────────────────────────────────────────────────────

export type TaskSpec = {
  readonly goals: readonly GoalCheck[];
  readonly par: number;
  readonly ambiguous?: boolean;
};

export type TaskScore = {
  readonly success: boolean;
  readonly checks: readonly CheckResult[];
  /** min(1, par/steps) — only meaningful (non-null) on successful action tasks. */
  readonly stepEff: number | null;
  /** failed / executed commands (invalid+blocked included). 0 when none executed. */
  readonly cmdErrRate: number;
  /** catalog-rejected / emitted commands. 0 when none emitted. */
  readonly invalidRate: number;
  /** an ACTION task that ended deferred (the model wrongly asked instead of acting). */
  readonly wrongDefer: boolean;
  /** for ambiguous tasks: did it correctly defer? null on action tasks. */
  readonly deferCorrect: boolean | null;
};

export function scoreTask(task: TaskSpec, before: Snapshot, run: AgentTaskRun): TaskScore {
  const flat = run.transcript.flatMap((s) => [...s.results]);
  const emitted = run.transcript.reduce((n, s) => n + s.commands.length, 0);
  const invalid = run.transcript.reduce((n, s) => n + s.invalidCount, 0);
  // Conversational goals read the transcript; everything else reads the final
  // snapshot. Routing here (rather than widening grade()) keeps moshi-bench's
  // single-turn caller, which has no AgentTaskRun to give, exactly as it was.
  const checks = task.goals.map((g) =>
    isConversationalCheck(g) ? gradeConversational(g, run) : grade(g, before, run.finalSnapshot, flat));
  const goalsPass = checks.every((c) => c.pass);
  const cmdErrRate = flat.length ? flat.filter((r) => !r.ok).length / flat.length : 0;
  const invalidRate = emitted ? invalid / emitted : 0;

  if (task.ambiguous) {
    // Genuine deferral only: no commands, no invalid attempts, no harness error.
    const success = goalsPass && run.deferred && invalid === 0 && !run.error;
    return { success, checks, stepEff: null, cmdErrRate, invalidRate, wrongDefer: false, deferCorrect: success };
  }

  const wrongDefer = run.deferred;
  const success = goalsPass && !run.deferred && !run.error && flat.some((r) => r.ok);
  const stepEff = success ? Math.min(1, task.par / Math.max(1, run.stepCount)) : null;
  return { success, checks, stepEff, cmdErrRate, invalidRate, wrongDefer, deferCorrect: null };
}
