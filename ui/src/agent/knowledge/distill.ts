// Parse + validate recipe-card candidates emitted by a non-TS source (the LLM distiller,
// the YouTube miner). This is the FIRST gate: shape + known commands + known $tokens +
// known check kind. A candidate that passes is structurally runnable; the loop
// (validateCommand → exec → runCheck → judgeConformance) is the second, deeper gate that
// proves it actually applies + conforms. Hallucinations are rejected HERE and logged, so
// the engine never sees an invented command or a dangling token. Pure + browser-safe.
import type { RecipeCommand } from "./recipe";
import { CHECK_KINDS, type CheckSpec, type CheckKind } from "./check";
import type { TaskType } from "./card";

export type CandidateMeta = {
  skill_name: string;
  task_type: TaskType;
  genre_context: string[];
  producer_intent: string;
  when: string;
};
// A candidate is a seed card without the closure: meta + commands + a declarative check.
export type CandidateCard = { meta: CandidateMeta; commands: RecipeCommand[]; check: CheckSpec };

export type DistillReject = { reason: string; raw: unknown };
export type DistillResult = { cards: CandidateCard[]; rejects: DistillReject[] };

const TASK_TYPES: TaskType[] = [
  "sound_design", "arrangement", "mixing", "drum_programming",
  "melody", "bass", "plugin_chain", "prompt_craft", "other",
];

// Lenient JSON extraction — strip a ```json fence / surrounding prose, then take the
// outermost {...}. Mirrors flywheel.mts's extractJson (small models wrap their reply).
function extractJson(content: string): any {
  let s = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// Scan balanced, string-aware {...} objects from `from`, JSON.parse each, keep the ones
// that parse. Stops at the first unterminated object — so a TRUNCATED final card (the
// #1 flash failure mode) is dropped while every complete card before it survives.
function scanObjects(s: string, from: number): unknown[] {
  const out: unknown[] = [];
  let i = Math.max(from, 0);
  while (i < s.length) {
    if (s[i] !== "{") { i++; continue; }
    let depth = 0, j = i, inStr = false, esc = false, closed = false;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { if (--depth === 0) { closed = true; break; } }
    }
    if (!closed) break; // unterminated → truncation; earlier complete objects already kept
    try { out.push(JSON.parse(s.slice(i, j + 1))); } catch { /* skip */ }
    i = j + 1;
  }
  return out;
}

// The candidate list, truncation-tolerant: a clean parse when the reply is whole, else
// salvage the complete card objects after `"cards":[` (or anywhere, if no wrapper).
function extractCardList(raw: string): unknown[] {
  const direct = extractJson(raw);
  if (direct && Array.isArray(direct.cards)) return direct.cards;
  if (Array.isArray(direct)) return direct;
  const s = String(raw || "");
  const ci = s.indexOf('"cards"');
  const from = ci >= 0 ? s.indexOf("[", ci) + 1 : 0;
  return scanObjects(s, from);
}

// Every "$name" string anywhere in a value (command args, check fields) → the bare name.
function collectTokens(v: unknown, acc: Set<string>): void {
  if (typeof v === "string") { if (v.startsWith("$") && v.length > 1) acc.add(v.slice(1)); return; }
  if (Array.isArray(v)) { for (const x of v) collectTokens(x, acc); return; }
  if (v && typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) collectTokens(x, acc); }
}

export function parseDistilledCards(raw: string, opts: { commands: string[]; tokens: string[] }): DistillResult {
  const cmdSet = new Set(opts.commands);
  const tokSet = new Set(opts.tokens);
  const cards: CandidateCard[] = [];
  const rejects: DistillReject[] = [];

  for (const c of extractCardList(raw)) {
    const reject = (reason: string) => rejects.push({ reason, raw: c });
    if (!c || typeof c !== "object") { reject("not an object"); continue; }
    const o = c as Record<string, any>;

    if (typeof o.skill_name !== "string" || !o.skill_name.trim()) { reject("missing skill_name"); continue; }
    const name = o.skill_name.trim();

    if (!Array.isArray(o.commands) || o.commands.length === 0) { reject(`${name}: no commands`); continue; }
    const commands: RecipeCommand[] = [];
    let badCmd = "";
    for (const cmd of o.commands) {
      if (!cmd || typeof cmd !== "object" || typeof cmd.command !== "string") { badCmd = "malformed command entry"; break; }
      if (!cmdSet.has(cmd.command)) { badCmd = `unknown command "${cmd.command}"`; break; }
      commands.push({ command: cmd.command, args: (cmd.args && typeof cmd.args === "object") ? cmd.args : {} });
    }
    if (badCmd) { reject(`${name}: ${badCmd}`); continue; }

    const check = o.check;
    if (!check || typeof check !== "object" || typeof check.kind !== "string" || !CHECK_KINDS.includes(check.kind as CheckKind)) {
      reject(`${name}: missing/unknown check kind "${check?.kind ?? ""}"`); continue;
    }

    // Every $token used (in commands or the check) must be a known binding slot, or the
    // ref would stay literal and the move could never land. Reject early with the name.
    const toks = new Set<string>();
    collectTokens(commands, toks);
    collectTokens(check, toks);
    const unknownTok = [...toks].find((t) => !tokSet.has(t));
    if (unknownTok) { reject(`${name}: unknown token "$${unknownTok}"`); continue; }

    const task_type = TASK_TYPES.includes(o.task_type) ? (o.task_type as TaskType) : "other";
    cards.push({
      meta: {
        skill_name: name,
        task_type,
        genre_context: Array.isArray(o.genre_context) ? o.genre_context.filter((g: unknown) => typeof g === "string") : [],
        producer_intent: typeof o.producer_intent === "string" ? o.producer_intent : "",
        when: typeof o.when === "string" ? o.when : "",
      },
      commands,
      check: check as CheckSpec,
    });
  }
  return { cards, rejects };
}
