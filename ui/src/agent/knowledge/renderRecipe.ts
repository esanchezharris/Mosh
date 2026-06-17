// Render a RECIPE card's concrete commands into a compact, agent-readable "worked example"
// for prompt injection. PURE + dependency-free + env-free: the product bundle imports it via
// prompt.ts, and the live brain-eval must build the BYTE-IDENTICAL prompt the product sends.
//
// It is a function of the CARD ONLY — it never reads the live snapshot (a snapshot resolver
// would make the rendered prompt non-deterministic w.r.t. the session, and validateCommand
// never checks id existence anyway). $tokens become English TARGET LABELS; only session-
// agnostic musical VALUES (pitch/beat/velocity/swing/db/value) are shown — the values the
// cards already proved conformant, safe to copy — so the agent transcribes the content but
// binds ids from the "Current session" block. prompt-kind cards render nothing here (the
// caller injects their guidance verbatim).
import type { TechniqueCard } from "./card";

type Cmd = { command: string; args: Record<string, unknown> };

// $token → readable target label. The raw token / a fabricated id is NEVER printed.
const TOKEN_LABEL: Record<string, string> = {
  drumTrackId: "the drum track",
  drumClipId: "the drum clip",
  hatsTrackId: "the hats track",
  hatsClipId: "the hats clip",
  keysTrackId: "the keys track",
  keysClipId: "the keys clip",
  keysFilterPluginIndex: "the keys filter",
  keysFilterParamIndex: "the keys filter",
  busNumber: "the new send bus",
};

// Drum-voice names for the common pitches a recipe lays down (kick/snare/hat/…).
const DRUM_NAME: Record<number, string> = { 36: "kick", 38: "snare", 42: "hat", 46: "open-hat", 39: "clap", 37: "rim" };

const label = (v: unknown, fallback = "the target clip/track"): string =>
  typeof v === "string" && v.startsWith("$") ? TOKEN_LABEL[v.slice(1)] ?? fallback : fallback;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// division (in beats) → a spelled-out note value for the human gloss. Deliberately NOT a
// "1/8" fraction: the model copies what it sees, and division is a NUMBER arg — a "1/8"
// string fails validateCommand. The literal number (e.g. 0.5) is shown as the arg itself.
const gridNote = (division: number): string =>
  ({ 1: "quarter-note", 0.5: "eighth-note", 0.25: "sixteenth-note" } as Record<number, string>)[division] ?? "grid";

// add_note grid → one entry per drum voice (first-appearance order): name(pitch)@beat,beat,…
function renderAddNotes(cmds: Cmd[]): string {
  const order: number[] = [];
  const beats = new Map<number, number[]>();
  const vels: number[] = [];
  let clip: unknown;
  for (const c of cmds) {
    const pitch = num(c.args.pitch), start = num(c.args.start);
    if (pitch === undefined || start === undefined) continue;
    if (!beats.has(pitch)) { beats.set(pitch, []); order.push(pitch); }
    beats.get(pitch)!.push(start);
    const v = num(c.args.velocity); if (v !== undefined) vels.push(v);
    if (clip === undefined) clip = c.args.clipId;
  }
  const voices = order.map((p) => `${DRUM_NAME[p] ?? "note"}(${p})@${beats.get(p)!.join(",")}`).join(" · ");
  const vel = vels.length ? ` (velocity ${Math.min(...vels)}-${Math.max(...vels)})` : "";
  return `add each note to ${label(clip)} (use the real clip id from the session; don't copy these): ${voices}${vel}`;
}

function renderQuantize(c: Cmd): string {
  const div = num(c.args.division), swing = num(c.args.swing);
  // Show the LITERAL numeric args (division 0.5, swing 0.58) — the values the command takes —
  // with a spelled-out grid gloss the model won't mistake for a numeric arg.
  const args = [div !== undefined ? `division ${div}` : "", swing !== undefined ? `swing ${swing}` : ""].filter(Boolean).join(", ");
  const gloss = div !== undefined ? ` (an ${gridNote(div)} swung grid)` : "";
  return `quantize ${label(c.args.clipId)} — ${args}${gloss} (use the real clip id from the session)`;
}

function renderHumanize(c: Cmd): string {
  const parts: string[] = [];
  const t = num(c.args.timing); if (t !== undefined) parts.push(`timing ${t}`);
  const v = num(c.args.velocity); if (v !== undefined) parts.push(`velocity ${v}`);
  const s = num(c.args.seed); if (s !== undefined) parts.push(`seed ${s}`);
  return `humanize ${label(c.args.clipId)}: ${parts.join(", ")} (use the real clip id from the session)`;
}

function renderAutomation(cmds: Cmd[]): string {
  const values = cmds.map((c) => num(c.args.value)).filter((v): v is number => v !== undefined);
  const from = values[0], to = values[values.length - 1];
  const sweep = from !== undefined && to !== undefined ? ` from ${from} to ${to}` : "";
  // pluginIndex/paramIndex stay prose — never a guessed literal; point to the snapshot.
  return `automate ${label(cmds[0]?.args.pluginIndex, "the filter/EQ plugin")}${sweep} across the bars with add_automation_point (read its plugin+param index from the snapshot fx: line)`;
}

function renderSend(cmds: Cmd[]): string {
  const send = cmds.find((c) => c.command === "add_send");
  const db = num(send?.args.db);
  return `create a send bus, then add_send from ${label(send?.args.trackId)} to it${db !== undefined ? ` at ${db} dB` : ""} (use the real bus number from the session)`;
}

/** A one-line worked example for a recipe card (concrete pitches/beats/params with $tokens
 *  delabeled). Empty string for prompt-kind cards. Pure: same card → byte-identical output. */
export function renderRecipeExample(card: TechniqueCard): string {
  if (card.recipe.kind !== "recipe") return "";
  const cmds = card.recipe.commands as Cmd[];
  const of = (name: string) => cmds.filter((c) => c.command === name);
  if (of("add_note").length) return renderAddNotes(of("add_note"));
  if (of("quantize_notes").length) return renderQuantize(of("quantize_notes")[0]);
  if (of("humanize_notes").length) return renderHumanize(of("humanize_notes")[0]);
  if (of("add_automation_point").length) return renderAutomation(of("add_automation_point"));
  if (of("create_bus").length || of("add_send").length) return renderSend(cmds);
  // Fallback: name the commands only (never args → no $token can leak).
  const names = [...new Set(cmds.map((c) => c.command))].join(", ");
  return names ? `applies ${names} (use the real ids from the session)` : "";
}
