// Pure prompt + parse logic for Moshi's brain — deliberately FREE of any bridge /
// window dependency, so it can be imported by the offline benchmark runner (pure
// Node, scripts/brainBench.mts) as well as the app. brain.ts adds the bridge-coupled
// createBrain() on top of this; the benchmark scores the EXACT prompt + parser here.

import { commandCatalogPrompt, AGENT_COMMAND_MAP } from "./commands";
import { retrieveCards, knowledgePromptSection } from "./knowledge";
import type { Snapshot } from "../types";
import type { AgentCommandCall } from "./executor";

export type BrainReply = { say?: string; intent?: string; commands?: AgentCommandCall[] };

export const INTENTS = ["ACK_GOT_IT", "ACK_WORKING", "DONE", "HUH", "NUH", "UHOH", "GREET", "IDLE_MURMUR"];

const db = (v: unknown): string => `${typeof v === "number" ? +v.toFixed(1) : 0}dB`;

/** How Moshi SEES the session — the single renderer for every path.
 *
 *  History worth knowing before touching this: there used to be two. The
 *  single-shot brain rendered a `compactSnapshot` (tempo, sections, tracks) while
 *  the agentic loop rendered this richer block, on the reasoning that brainCore was
 *  "byte-frozen for the SFT/gepa/bench consumers". The freeze held, and the cost of
 *  it was that the shipped brain could not see the master bus, buses, the key or
 *  the tempo map — so it was routinely asked to change things it had never been
 *  shown. Measured 2026-07-27: EVERY model scored 0/3 or 1/3 on the bench's
 *  `master` category through the compact renderer, while the loop (this block) and
 *  a tool-driving seat that could call get_snapshot both got the same tasks right.
 *  Since `agenticLoop` defaults OFF, that blindness shipped to real users.
 *
 *  So: one renderer, used by both paths. Two renderers is what caused the gap, and
 *  keeping them in sync by hand is the thing that already failed once.
 *
 *  What the model needs to SEE, beyond the obvious: master (whose fader defaults to
 *  −3dB, so "it's quiet" is often about a control it can't otherwise find), the
 *  master chain, buses, the tempo map WITH the indices remove_tempo_change takes,
 *  the key, and per-track pan/sends. */
export function sessionBlock(s: Snapshot): string {
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
  const sections = (s.sections ?? [])
    .map((x) => `${x.id} "${x.name}" beats ${x.startBeat}-${x.endBeat}`)
    .join("; ");
  lines.push(`sections: ${sections || "(none)"}`);
  const tracks = (s.tracks ?? [])
    .map((t) => {
      // ids are QUOTED so the model copies them as JSON strings — an unquoted
      // numeric-looking id (e.g. 17) gets emitted as the number 17, which fails
      // the string-typed trackId/clipId validation and the command is dropped.
      //
      // Clip LENGTH is rendered next to start because trim_clip/split_clip need it:
      // "make it 3 seconds" is unanswerable without knowing what it is now.
      const clips = (t.clips ?? [])
        .map((c) => {
          const gain = typeof c.gainDb === "number" && c.gainDb !== 0 ? ` ${c.gainDb}dB` : "";
          return `"${c.id}":${c.type}@${c.start}s+${c.length ?? 0}s${gain}${c.mute ? " muted" : ""}`;
        })
        .join(", ");
      const sends = ((t as { sends?: Array<{ bus: number; db?: number }> }).sends ?? [])
        .map((x) => `bus${x.bus}@${x.db ?? 0}dB`).join(",");
      // The per-track FX chain, IN ORDER — remove_plugin and reorder_plugin address
      // plugins by index, so without this the model is choosing an index blind.
      const fx = (t.plugins ?? [])
        .map((p, i) => `${i}:${(p as { name?: string; type?: string }).name ?? (p as { type?: string }).type ?? "?"}`)
        .join(",");
      // Track TYPE decides what a command may legally do to it — a drum pattern on a
      // wave track is rejected, and every model measured answered that rejection by
      // converting the track (losing the audio). It could not see the type.
      const kind = t.type ? ` ${t.type}` : "";
      return `  "${t.id}" "${t.name}"${kind} ${t.volumeDb ?? 0}dB${t.pan ? ` pan ${t.pan}` : ""}${t.mute ? " muted" : ""}${t.solo ? " solo" : ""}${t.armed ? " armed" : ""}${sends ? ` sends:[${sends}]` : ""}${fx ? ` fx:[${fx}]` : ""} clips:[${clips}]`;
    })
    .join("\n");
  lines.push("tracks:", tracks || "  (none)");
  return lines.join("\n");
}

// The fixed persona/format preamble. Not optimized — it defines the reply contract.
const PREAMBLE = [
  "You ARE Moshi — a small, warm, playful creature, the agent living inside a music app called Mosh.",
  "You mostly communicate by emoting + a SOUND (an INTENT), not words. Only add a short `say` when a precise message is truly needed.",
  "You can EDIT the user's session by emitting commands. Reply with ONE compact JSON object and NOTHING else:",
  `{ "intent": one of [${INTENTS.join(", ")}], "say"?: string (<=12 words), "commands"?: [ { "command": string, "args": object } ] }`,
  "You may ONLY use these commands — exact names + args (a trailing ? marks optional):",
].join("\n");

// The OPTIMIZABLE rules block — the segment GEPA (gepa/) rewrites against the
// verifier reward. Kept as a single exported string so an optimized variant can be
// swapped in (or A/B'd) without touching the preamble, catalog, or snapshot render.
export const DEFAULT_RULES = [
  "Rules:",
  "- Use the REAL ids from the session below for trackId/clipId. Never invent ids or commands.",
  '- trackId/clipId are STRING ids: match one from the session exactly and pass it as a JSON string, e.g. "trackId": "17" — never the bare number 17, and never with extra quote characters inside the value.',
  "- One request can produce several commands (they apply together as one undoable change).",
  "- To re-imagine PART of the song (e.g. \"rework the hook\"), scope a render to that SECTION: create_render_layer on the wave clip under the section with regionStart/regionEnd in SECONDS (beats × 60 ÷ tempo), then render_layer.",
  "- If the request is unclear or needs info you don't have, set intent HUH and ask in `say` — don't guess.",
  "- After making edits use intent ACK_GOT_IT (or DONE for a finishing flourish).",
  "- Stay in character. Never mention JSON, models, commands, or that you're an AI.",
].join("\n");

/** Assemble the full system prompt from an (optimizable) rules block + a snapshot.
 *  PREAMBLE + catalog + [knowledge] + [memory] + rules + session — the order
 *  systemPrompt has always used, with the producer-knowledge block inserted next to
 *  the catalog and the M2 memory block (preferences/patterns/project notes) right
 *  after it. `catalog` swaps the command catalog (the small-model-mode eval arm);
 *  omitted = the full catalog. `knowledge` is a pre-rendered producer-knowledge
 *  block; `memory` is a pre-rendered memory block (retrieveContext() in
 *  agent/memory/retrieveContext.ts) — BOTH omitted or empty ⇒ not inserted, so every
 *  existing caller (GEPA / SFT / harvest, and every call site that predates the M2
 *  memory param) is byte-unchanged. */
export function buildSystemPrompt(
  rules: string,
  snap: Snapshot | null,
  catalog?: string,
  knowledge?: string,
  memory?: string,
): string {
  const parts = [PREAMBLE, catalog ?? commandCatalogPrompt()];
  if (knowledge) parts.push(knowledge);
  if (memory) parts.push(memory);
  parts.push(rules, "Current session:", snap ? sessionBlock(snap) : "(empty session)");
  return parts.join("\n");
}

/** The production system prompt. Pass the user's request as `query` to inject the few
 *  most-relevant producer-knowledge cards; omit it (e.g. offline harvest that has no
 *  turn text yet) for the byte-identical no-knowledge prompt. `memory` is an optional
 *  pre-rendered memory block (M2) — the caller (brain.ts) computes it via
 *  retrieveContext() behind the `agentMemory` settings flag; omitted ⇒ no change to
 *  this function's prior (pre-M2) behavior. */
export function systemPrompt(snap: Snapshot | null, query?: string, memory?: string): string {
  const knowledge = query ? knowledgePromptSection(retrieveCards(query)) : "";
  return buildSystemPrompt(DEFAULT_RULES, snap, undefined, knowledge, memory);
}

// Coerce a string token ("17", 132, true) to the type an arg expects.
function coerceArg(tok: string, type: "string" | "number" | "boolean"): unknown {
  let raw = tok.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  if (type === "number") { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

// Some models emit commands in the catalog's function-call FORM — a string like
// `add_midi_clip("17")` — instead of the {command,args} object (it mimics
// commandCatalogPrompt()). Normalize that back to the object contract by mapping the
// positional args onto the command's declared arg names. Returns null if unusable.
// add_drum_pattern's NATIVE handler accepts the pattern as an object
// ({kick:"x..."}) OR a flat lane-map string, but ArgSpec can only declare the
// string form — and models naturally emit the object (it's the idiomatic JSON
// shape; the Phase-A baseline measured every model losing compose-drums to
// client-side validation over exactly this). Flatten the natively-valid object
// into the declared flat form so validation matches the real contract.
function normalizeDrumPatternArgs(args: Record<string, unknown>): Record<string, unknown> {
  const p = args.pattern;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const flat = Object.entries(p as Record<string, unknown>)
      .map(([lane, cells]) => `${lane}: ${String(cells)}`)
      .join("; ");
    return { ...args, pattern: flat };
  }
  // Models also separate lanes with newlines instead of semicolons — the flat
  // parser then reads the next lane's NAME as pattern chars. Canonicalize any
  // newline/semicolon mix into the declared "; "-separated form.
  if (typeof p === "string" && /[\r\n]/.test(p)) {
    const flat = p.split(/[\r\n;]+/).map((s) => s.trim()).filter(Boolean).join("; ");
    return { ...args, pattern: flat };
  }
  return args;
}

// Models also emit string-typed values on declared number/boolean args in the
// OBJECT form ({"note":"42"}, {"mute":"true"}) — the same class coerceArg fixes
// for the function-call-string form. Coerce per the catalog's ArgSpec; anything
// that doesn't parse cleanly is left alone so validation still fails loudly.
function coerceObjectArgs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  const spec = AGENT_COMMAND_MAP.get(command);
  if (!spec) return args;
  let out: Record<string, unknown> | null = null;
  for (const a of spec.args) {
    const v = args[a.name];
    if (typeof v !== "string" || a.type === "string") continue;
    const coerced = coerceArg(v, a.type);
    if (coerced !== v) (out ??= { ...args })[a.name] = coerced;
  }
  return out ?? args;
}

export function normalizeCommand(c: unknown): AgentCommandCall | null {
  if (c && typeof c === "object" && typeof (c as AgentCommandCall).command === "string") {
    const o = c as AgentCommandCall;
    let args = (o.args && typeof o.args === "object" ? o.args : {}) as Record<string, unknown>;
    if (o.command === "add_drum_pattern") args = normalizeDrumPatternArgs(args);
    args = coerceObjectArgs(o.command, args);
    return { command: o.command, args };
  }
  if (typeof c !== "string") return null;
  const m = c.match(/^\s*([a-zA-Z_]\w*)\s*(?:\(([\s\S]*)\))?\s*;?\s*$/);
  if (!m) return null;
  const spec = AGENT_COMMAND_MAP.get(m[1]);
  if (!spec) return null;
  const args: Record<string, unknown> = {};
  const inner = (m[2] ?? "").trim();
  if (inner) inner.split(",").forEach((tok, i) => { const a = spec.args[i]; if (a) args[a.name] = coerceArg(tok, a.type); });
  return { command: m[1], args };
}

export function parseReply(content: string): BrainReply {
  let s = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as BrainReply;
    const commands = Array.isArray(o.commands)
      ? o.commands.map(normalizeCommand).filter((c): c is AgentCommandCall => c !== null)
      : undefined;
    return {
      say: typeof o.say === "string" ? o.say : undefined,
      intent: typeof o.intent === "string" ? o.intent : undefined,
      commands,
    };
  } catch {
    return { say: undefined, intent: "HUH" };
  }
}
