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
  // Builtins render by their `type` id — the exact string load_master_builtin /
  // load_builtin take — NOT their display name. The engine's builtin table
  // (MoshOps.cpp kBuiltins) deliberately differs between the two: type
  // "compressor" vs name "Compressor", type "4bandEq" vs name "4-Band EQ". A
  // chain rendered as `[Compressor]` teaches a model to emit type "Compressor",
  // which the engine rejects with `unknown builtin: Compressor`.
  // Externals keep their NAME: an external's `type` is getPluginType(), a format
  // label ("vst"), so rendering it would make every real plugin indistinguishable.
  const pluginLabel = (p: unknown): string => {
    const q = p as { name?: string; type?: string; builtin?: boolean };
    return q.builtin && q.type ? q.type : q.name ?? "?";
  };
  const chain = (m?.plugins ?? []).map(pluginLabel).join(", ");
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
      // WHAT the track sounds like — the 94eeb18 "template awareness" mechanism:
      // without the instrument in view the model writes for an abstract track and
      // cannot reason about arrangement texture (flywheel pillar 2). Instrument by
      // the same builtin-type/external-name rule as the master chain; fx listed
      // separately so a synth is never buried mid-chain. Every segment is
      // CONDITIONAL: a plugin-less track renders byte-identically to the pre-2026-09
      // shape, which is what keeps the Python SFT mirror (render_session, plugin-less
      // fixture by construction) in byte parity without a Python change.
      const plugs = (t as { plugins?: Array<{ isInstrument?: boolean }> }).plugins ?? [];
      const inst = plugs.find((p) => p.isInstrument);
      const fx = plugs.filter((p) => !p.isInstrument).map(pluginLabel).join(", ");
      const kind = (t as { type?: string }).type === "drum" ? " [drum]" : "";
      return `  "${t.id}" "${t.name}"${kind}${inst ? ` inst:${pluginLabel(inst)}` : ""}${fx ? ` fx:[${fx}]` : ""} ${t.volumeDb ?? 0}dB${t.pan ? ` pan ${t.pan}` : ""}${t.mute ? " muted" : ""}${t.solo ? " solo" : ""}${sends ? ` sends:[${sends}]` : ""} clips:[${clips}]`;
    })
    .join("\n");
  lines.push("tracks:", tracks || "  (none)");
  return lines.join("\n");
}
