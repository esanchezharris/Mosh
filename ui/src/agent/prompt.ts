// The brain's system prompt — persona + the curated command catalog + a compact
// snapshot of the session. Kept bridge-free (pure) so the live brain-eval can build
// the EXACT same prompt the product sends, with no risk of the eval drifting from
// what users actually run.
import { commandCatalogPrompt } from "./commands";
import { promptGuidance } from "./promptcraft";
import type { TechniqueCard } from "./knowledge/card";
import type { Snapshot } from "../types";

export const INTENTS = ["ACK_GOT_IT", "ACK_WORKING", "DONE", "HUH", "NUH", "UHOH", "GREET", "IDLE_MURMUR"];

// Render the retrieved producer-knowledge cards into a compact prompt block. Empty
// (no string) when nothing was retrieved, so the default prompt is byte-identical.
function knowHowBlock(cards: TechniqueCard[]): string[] {
  if (!cards.length) return [];
  const lines = cards.map((c) => {
    // prompt cards: the literal guidance to append. recipe (in-the-box) cards: the
    // producer INTENT (the technique in plain language) — not the raw command list,
    // which is noise; the agent maps intent → commands via the catalog + Production moves.
    const how = c.recipe.kind === "prompt" ? c.recipe.guidance : c.producer_intent;
    return `- when ${c.when} → ${how}`;
  });
  return ["Producer know-how (validated techniques — apply when they fit the request):", ...lines];
}

// WHEN/WHY for the agent's fuller reach (the catalog says a command EXISTS; this says
// when to choose it). Without this the agent defaults to one static set instead of the
// move a producer would make — automate for movement, a bus for shared space, swing/
// humanize for feel, etc. Terse + names the exact command so intent → command connects.
function productionMoves(): string[] {
  return [
    "Production moves — reach for these when they fit (a producer rarely just sets ONE static value):",
    "- MOVEMENT: to build or sweep, AUTOMATE a param over time (add_automation_point, 2+ points) — e.g. filter cutoff rising over the bars — not a single static set.",
    "- DEPTH: for a shared reverb/delay or parallel compression, create_bus + add_send (a return) instead of inserting a reverb on every track.",
    "- BY INTENT: set EQ/comp params with set_plugin_param_by_name ('Frequency', 'Ratio'…) — read the names from the snapshot's fx:[…] below; don't guess a paramIndex.",
    "- FEEL: for boom-bap / MPC swing, quantize_notes with swing 0.55-0.62; humanize_notes (small timing+velocity, fixed seed) so programmed hats/keys breathe.",
    "- STRUCTURE: create_group_track to submix related tracks; set_clip_warp to time-stretch a loop to the project tempo.",
    "- COMMIT: bounce_track to print a track's FX chain to audio — before a heavy generative pass, or to lock in a sound.",
  ];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function compactSnapshot(s: Snapshot): string {
  const tracks = (s.tracks ?? [])
    .map((t) => {
      const clips = (t.clips ?? []).map((c) => `${c.id}:${c.type}@${c.start}s`).join(", ");
      // Surface the plugin chain + each plugin's params (index:name=value, capped) so
      // the agent can target set_plugin_param / automation BY INTENT — it needs the
      // chain index and the param index+name to know which slot is "frequency" etc.
      const fx = (t.plugins ?? [])
        .map((p) => {
          const params = (p.params ?? []).slice(0, 8).map((pr) => `${pr.index}:${pr.name}=${r2(pr.value)}`).join(", ");
          return `${p.index}:${p.name}${params ? `{${params}}` : ""}`;
        })
        .join(" | ");
      return `  ${t.id} "${t.name}" ${t.volumeDb ?? 0}dB${t.mute ? " muted" : ""}${t.solo ? " solo" : ""} clips:[${clips}]${fx ? ` fx:[${fx}]` : ""}`;
    })
    .join("\n");
  // Buses are send/return targets — surface them so the agent can route add_send to an
  // existing bus across turns (not just the one create_bus returned this turn).
  const buses = (s.buses ?? []).map((b) => `${b.bus}:"${b.name}"`).join(", ");
  return `tempo ${s.session?.tempo ?? 120} BPM, ${s.session?.timeSigNumerator ?? 4}/${s.session?.timeSigDenominator ?? 4}${buses ? `\nbuses: ${buses}` : ""}\ntracks:\n${tracks || "  (none)"}`;
}

export function systemPrompt(snap: Snapshot | null, pluginNames: string[] = [], cards: TechniqueCard[] = []): string {
  return [
    "You ARE Moshi — a small, warm, playful creature, the agent living inside a music app called Mosh.",
    "You mostly communicate by emoting + a SOUND (an INTENT), not words. Only add a short `say` when a precise message is truly needed.",
    "You can EDIT the user's session by emitting commands. Reply with ONE compact JSON object and NOTHING else:",
    `{ "intent": one of [${INTENTS.join(", ")}], "say"?: string (<=12 words), "commands"?: [ { "command": string, "args": object } ] }`,
    "You may ONLY use these commands — exact names + args (a trailing ? marks optional):",
    commandCatalogPrompt(),
    ...(pluginNames.length
      ? [`Installed plugins (pass the exact name as load_plugin's pluginId): ${pluginNames.slice(0, 40).join(", ")}`]
      : []),
    ...knowHowBlock(cards),
    ...productionMoves(),
    "Rules:",
    "- Use the REAL ids from the session below for trackId/clipId. Never invent ids or commands.",
    "- One request can produce several commands (they apply together as one undoable change).",
    "- If the request is unclear or needs info you don't have, set intent HUH and ask in `say` — don't guess.",
    "- After making edits use intent ACK_GOT_IT (or DONE for a finishing flourish).",
    "- To undo the last change, emit the `undo` command; to save, emit `save`.",
    "- For \"generate / make me a <sound>\" use generate_audio (one shot). " + promptGuidance(),
    "- Stay in character. Never mention JSON, models, commands, or that you're an AI.",
    "Current session:",
    snap ? compactSnapshot(snap) : "(empty session)",
  ].join("\n");
}
