// Pure prompt + parse logic for Moshi's brain — deliberately FREE of any bridge /
// window dependency, so it can be imported by the offline benchmark runner (pure
// Node, scripts/brainBench.mts) as well as the app. brain.ts adds the bridge-coupled
// createBrain() on top of this; the benchmark scores the EXACT prompt + parser here.

import { commandCatalogPrompt, AGENT_COMMAND_MAP } from "./commands";
import type { Snapshot } from "../types";
import type { AgentCommandCall } from "./executor";

export type BrainReply = { say?: string; intent?: string; commands?: AgentCommandCall[] };

export const INTENTS = ["ACK_GOT_IT", "ACK_WORKING", "DONE", "HUH", "NUH", "UHOH", "GREET", "IDLE_MURMUR"];

function compactSnapshot(s: Snapshot): string {
  const tracks = (s.tracks ?? [])
    .map((t) => {
      // ids are QUOTED so the model copies them as JSON strings — an unquoted
      // numeric-looking id (e.g. 17) gets emitted as the number 17, which fails
      // the string-typed trackId/clipId validation and the command is dropped.
      const clips = (t.clips ?? []).map((c) => `"${c.id}":${c.type}@${c.start}s`).join(", ");
      return `  "${t.id}" "${t.name}" ${t.volumeDb ?? 0}dB${t.mute ? " muted" : ""}${t.solo ? " solo" : ""} clips:[${clips}]`;
    })
    .join("\n");
  const sections = (s.sections ?? [])
    .map((x) => `${x.id} "${x.name}" beats ${x.startBeat}-${x.endBeat}`)
    .join("; ");
  return `tempo ${s.session?.tempo ?? 120} BPM, ${s.session?.timeSigNumerator ?? 4}/${s.session?.timeSigDenominator ?? 4}\nsections: ${sections || "(none)"}\ntracks:\n${tracks || "  (none)"}`;
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
 *  PREAMBLE + catalog + rules + session — the order systemPrompt has always used. */
export function buildSystemPrompt(rules: string, snap: Snapshot | null): string {
  return [
    PREAMBLE,
    commandCatalogPrompt(),
    rules,
    "Current session:",
    snap ? compactSnapshot(snap) : "(empty session)",
  ].join("\n");
}

export function systemPrompt(snap: Snapshot | null): string {
  return buildSystemPrompt(DEFAULT_RULES, snap);
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
function normalizeCommand(c: unknown): AgentCommandCall | null {
  if (c && typeof c === "object" && typeof (c as AgentCommandCall).command === "string") {
    const o = c as AgentCommandCall;
    return { command: o.command, args: (o.args && typeof o.args === "object" ? o.args : {}) as Record<string, unknown> };
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
