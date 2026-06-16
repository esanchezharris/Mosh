// Shared prompt scaffolding for distilling RECIPE cards — used by both the LLM distiller
// (scripts/recipeDistill.mts, brief-driven) and the YouTube miner (scripts/ytMiner.mts,
// transcript-driven). The two differ only in their FRAMING; the base-session description,
// the allowed command subset, the CheckSpec schemas, the "prefer patterns" steer, and the
// strict output shape are identical, so a card from either source parses + runs the same.
// Pure (imports the catalog only). Keep in sync with recipeBase.BaseBindings + check.ts.
import { AGENT_COMMANDS } from "../commands";

// The in-the-box command subset a recipe card may use (each maps to a conformance reader).
export const IN_THE_BOX_COMMANDS = ["add_note", "quantize_notes", "humanize_notes", "add_automation_point", "create_bus", "add_send"];
// The base arrangement's $token vocabulary (recipeBase.BaseBindings) + the runtime capture.
export const BASE_TOKENS = ["drumTrackId", "drumClipId", "hatsTrackId", "hatsClipId", "keysTrackId", "keysClipId", "keysFilterPluginIndex", "keysFilterParamIndex", "busNumber"];

export const DISTILL_SYS =
  "You are a senior music producer teaching an AI DAW agent IN-THE-BOX technique (MIDI " +
  "programming, groove, automation, routing). Return ONLY JSON, no prose.";

/** The allowed command subset rendered with its real arg signatures, for the prompt. */
export function commandSubsetText(): string {
  const map = new Map(AGENT_COMMANDS.map((c) => [c.command, c]));
  return IN_THE_BOX_COMMANDS.map((name) => {
    const c = map.get(name);
    if (!c) return `- ${name}`;
    const a = c.args.map((x) => `${x.name}${x.required ? "" : "?"}`).join(", ");
    return `- ${name}(${a}) — ${c.desc}`;
  }).join("\n");
}

/** The shared rules block: base session, allowed commands, the CheckSpec menu, and the
 *  strict output shape. Each caller prepends its own framing (a brief, or a transcript). */
export function recipeCardRules(): string[] {
  return [
    `Each card is a SEQUENCE of MoshOps commands applied to a fixed BASE session, plus a declarative CHECK that proves the move took effect (read symbolically from the session — no audio).`,
    ``,
    `The BASE session already has these tracks/clips. Refer to them ONLY by these $tokens:`,
    `- Drums track ($drumTrackId) with an EMPTY midi clip $drumClipId — fill it with a drum PATTERN (kick=36, snare=38, closed-hat=42, open-hat=46, clap=39, rim=37).`,
    `- Hats track ($hatsTrackId) with straight 8th-note hats in clip $hatsClipId — reprogram or swing them.`,
    `- Keys track ($keysTrackId): a synth + a 3-note arp in clip $keysClipId, and a 4-band EQ at plugin index $keysFilterPluginIndex whose frequency param index is $keysFilterParamIndex.`,
    `After a create_bus command, refer to the new bus as $busNumber.`,
    `Use NO other ids. start/length are in BEATS; 1 bar = 4 beats.`,
    ``,
    `You may ONLY use these commands:`,
    commandSubsetText(),
    ``,
    `The CHECK is exactly one of these (its refs MUST be the same $tokens your commands touch, and MUST match what your commands do):`,
    `- {"kind":"pattern","clip":"$drumClipId","pattern":{"hits":[{"pitch":36,"beats":[0,2]},{"pitch":38,"beats":[1,3]}]}}  — list every (pitch,beat) you add_note'd`,
    `- {"kind":"swing","clip":"$hatsClipId","division":0.5,"swing":0.58}  — after a quantize_notes with that division+swing`,
    `- {"kind":"humanize","clip":"$keysClipId","maxOffsetBeats":0.125}  — after a humanize_notes`,
    `- {"kind":"automation","track":"$keysTrackId","pluginIndex":"$keysFilterPluginIndex","paramIndex":"$keysFilterParamIndex","direction":"up"}  — after 2+ add_automation_point (up=rising, down=falling)`,
    `- {"kind":"send","track":"$keysTrackId","bus":"$busNumber","db":-12}  — after create_bus + add_send`,
    ``,
    `STRONGLY prefer multi-step PATTERN cards (a full drum or melodic grid of add_note commands) — those are the valuable, mineable ones. A single-knob card is weak.`,
    ``,
    `Output EXACTLY: {"cards":[{"skill_name":string,"task_type":"drum_programming"|"bass"|"melody"|"arrangement"|"mixing"|"sound_design"|"other","genre_context":[string],"producer_intent":string,"when":string,"commands":[{"command":string,"args":object}],"check":object}]}`,
  ];
}
