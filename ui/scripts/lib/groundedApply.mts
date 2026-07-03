// Shared grounded-apply grading for policy probes and the synthesis driver:
// catalog validation → session-id grounding → file existence → REAL engine apply.
// The failure classes mirror the observed policy failure modes (stale ids,
// invented file paths) so both tools speak the same taxonomy.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { validateCommand } from "../../src/agent/commands";
import type { Snapshot } from "../../src/types";
import { runScript, snapshotAt, type Cmd } from "./realEngine.mts";

export const FILE_ARG: Record<string, string> = {
  import_clip: "file",
  sketch_beatbox: "file",
  assign_sample: "file",
};

export function snapshotIds(snap: Snapshot): Set<string> {
  const ids = new Set<string>();
  for (const t of ((snap as any).tracks ?? []) as any[]) {
    if (t.id != null) ids.add(String(t.id));
    for (const c of t.clips ?? []) if (c.id != null) ids.add(String(c.id));
  }
  for (const s of ((snap as any).sections ?? []) as any[]) if (s.id != null) ids.add(String(s.id));
  for (const a of ((snap as any).annotations ?? []) as any[]) if (a.id != null) ids.add(String(a.id));
  return ids;
}

/** Ordered (kind:key, id) entity list — the structural identity of a session.
 *  Track/clip logical ids are deterministic for the same command prefix, but
 *  section/annotation ids are 32-hex and differ per run, so replaying a setup
 *  needs a dump-id → replay-id remap built by structural position. */
function snapshotEntities(snap: Snapshot): Array<{ key: string; id: string }> {
  const out: Array<{ key: string; id: string }> = [];
  const tracks = ((snap as any).tracks ?? []) as any[];
  tracks.forEach((t, ti) => {
    if (t.id != null) out.push({ key: `track:${ti}:${t.name ?? ""}`, id: String(t.id) });
    (t.clips ?? []).forEach((c: any, ci: number) => {
      if (c.id != null) out.push({ key: `clip:${ti}:${ci}`, id: String(c.id) });
    });
  });
  (((snap as any).sections ?? []) as any[]).forEach((s, si) => {
    if (s.id != null) out.push({ key: `section:${si}:${s.name ?? ""}`, id: String(s.id) });
  });
  (((snap as any).annotations ?? []) as any[]).forEach((a, ai) => {
    if (a.id != null) out.push({ key: `annotation:${ai}`, id: String(a.id) });
  });
  return out;
}

/** dump-snapshot → replay-snapshot id map; throws if the sessions differ structurally. */
export function buildIdRemap(dump: Snapshot, replay: Snapshot): Map<string, string> {
  const a = snapshotEntities(dump);
  const b = snapshotEntities(replay);
  if (a.length !== b.length || a.some((e, i) => e.key !== b[i].key))
    throw new Error("setup replay is not structurally identical — grading would be unsound");
  return new Map(a.map((e, i) => [e.id, b[i].id]));
}

// Random-id entities (section/annotation ids are 32-hex, fresh EVERY engine
// invocation) must be referenced via run-script ${VAR} captures so the remap and
// the execution happen in the SAME invocation. Track/clip logical ids are
// deterministic per command prefix (verified) and pass through unchanged —
// asserted against the replay snapshot after the run.
const CAPTURE_KINDS: Record<string, { field: string; list: string }> = {
  create_section: { field: "sectionId", list: "sections" },
  create_annotation: { field: "annotationId", list: "annotations" },
};

/** setup with capture bindings on random-id creators + dump-id → ${VAR} symbolic map. */
export function symbolicRemap(setup: Cmd[], dump: Snapshot): { setup: Cmd[]; map: Map<string, string> } {
  const counters: Record<string, number> = {};
  const wired = setup.map((c) => {
    const spec = CAPTURE_KINDS[c.command];
    if (!spec) return c;
    const k = counters[spec.list] ?? 0;
    counters[spec.list] = k + 1;
    return { ...c, capture: { ...(c.capture ?? {}), [`__${spec.list}${k}`]: spec.field } };
  });
  const map = new Map<string, string>();
  for (const [, spec] of Object.entries(CAPTURE_KINDS)) {
    (((dump as any)[spec.list] ?? []) as any[]).forEach((e, k) => {
      if (e.id != null) map.set(String(e.id), `\${__${spec.list}${k}}`);
    });
  }
  return { setup: wired, map };
}

export type ApplyGrade = {
  commands: number;   // emitted
  applied: number;    // cleanly applied on the real engine
  classes: string[];  // validation | stale-id | invented-file | apply-error (one per offence)
  runnable: Cmd[];    // the commands that survived pre-flight (and were executed)
};

/** Pre-flight + real apply. `setup` re-creates the session the snapshot came from;
 *  ids the model referenced (from the DUMP snapshot in its prompt) are remapped to
 *  the replay session's ids before executing. Pass `dumpSnap` (the snapshot the
 *  prompt was built from) so the remap can be constructed. */
export function gradeApply(
  bin: string,
  setup: Cmd[],
  ids: Set<string>,
  cmds: Array<{ command: string; args?: Record<string, unknown> }>,
  session: string,
  dumpSnap: Snapshot,
): ApplyGrade {
  const classes: string[] = [];
  const runnable: Cmd[] = [];
  for (const c of cmds) {
    const verr = validateCommand(c.command, (c.args ?? {}) as Record<string, unknown>);
    if (verr) { classes.push("validation"); continue; }
    let grounded = true;
    for (const [k, v] of Object.entries(c.args ?? {})) {
      if (/Id$/.test(k) && typeof v === "string" && !ids.has(v)) { classes.push("stale-id"); grounded = false; }
    }
    const farg = FILE_ARG[c.command];
    if (farg) {
      const p = String((c.args as any)?.[farg] ?? "").replace(/^~\//, homedir() + "/");
      if (!existsSync(p)) { classes.push("invented-file"); grounded = false; }
    }
    if (grounded) runnable.push({ command: c.command, args: (c.args ?? {}) as Record<string, unknown> });
  }
  let applied = 0;
  if (runnable.length) {
    const { setup: wired, map } = symbolicRemap(setup, dumpSnap);
    const remapped = runnable.map((c) => ({
      command: c.command,
      args: Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) =>
        [k, /Id$/.test(k) && typeof v === "string" && map.has(v) ? map.get(v) : v])),
    }));
    // ONE invocation: setup (with captures) → snapshot (for the determinism assert)
    // → the model's commands, with random ids resolved by the engine via ${VAR}.
    const run = runScript(bin, [...wired, { command: "__snapshot", args: { label: "replay" } }, ...remapped], session);
    const replay = (run.results.find((r) => r.command === "__snapshot")?.data ?? {}) as Snapshot;
    buildIdRemap(dumpSnap, replay); // structural assert (throws if setup replayed differently)
    const dumpTC = snapshotEntities(dumpSnap).filter((e) => e.key.startsWith("track:") || e.key.startsWith("clip:"));
    const repTC = snapshotEntities(replay).filter((e) => e.key.startsWith("track:") || e.key.startsWith("clip:"));
    if (dumpTC.some((e, i) => e.id !== repTC[i]?.id))
      throw new Error("track/clip ids not deterministic across replay — grading would be unsound");
    const tail = run.results.slice(wired.length + 1).filter((r) => r.command !== "__snapshot" && r.command !== "__wait");
    for (const r of tail) if (r.ok) applied++; else classes.push("apply-error");
  }
  return { commands: cmds.length, applied, classes, runnable };
}
