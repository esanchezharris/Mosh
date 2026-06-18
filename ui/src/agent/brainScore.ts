// Deterministic scorer for the simple-helper brain benchmark. No LLM judge: a reply
// is graded purely against the catalog + the case rubric, so the same reply always
// scores the same. Reused by both the offline unit test and the live matrix runner.

import { validateCommand } from "./commands";
import { INTENTS, parseReply, type BrainReply } from "./brainCore";
import { FIXTURE_IDS, type BrainCase } from "./brainCases";

export type CaseScore = {
  id: string;
  parsed: boolean;        // raw content was a single parseable JSON object
  intentOk: boolean;      // intent ∈ the catalog of intents
  commandsValid: boolean; // every command ∈ catalog, valid arg types, GROUNDED ids
  expectationOk: boolean; // matched the rubric (expected commands, or defer + no commands)
  pass: boolean;          // all of the above that apply to this case
  reply: BrainReply;
  notes: string[];        // human-readable reasons for any failure
};

// The only id-reference args in the curated catalog; any other value here would be
// an invented id (the model fabricating a target that isn't in the session).
const ID_ARGS = ["trackId", "clipId"];

// Strict parse mirroring brain.parseReply's extraction, but returning null on failure
// (parseReply masks a parse failure as intent HUH — we need to tell those apart).
function strictParse(raw: string): Record<string, unknown> | null {
  let s = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function scoreReply(raw: string, c: BrainCase): CaseScore {
  const notes: string[] = [];
  const reply = parseReply(raw);
  const parsed = strictParse(raw) !== null;
  if (!parsed) notes.push("reply is not a single JSON object");

  const intentOk = typeof reply.intent === "string" && INTENTS.includes(reply.intent);
  if (!intentOk) notes.push(`intent "${reply.intent ?? "(none)"}" not in the intent catalog`);

  const cmds = reply.commands ?? [];
  let commandsValid = true;
  for (const call of cmds) {
    const args = (call.args ?? {}) as Record<string, unknown>;
    const err = validateCommand(call.command, args);
    if (err) { commandsValid = false; notes.push(err); continue; }
    for (const k of ID_ARGS) {
      const v = args[k];
      if (typeof v === "string" && !FIXTURE_IDS.has(v)) {
        commandsValid = false;
        notes.push(`invented id ${k}="${v}"`);
      }
    }
  }

  let expectationOk: boolean;
  if (c.huh) {
    // Ambiguous / off-topic: the prompt's explicit rule is to defer (HUH/NUH) and act on nothing.
    const deferred = reply.intent === "HUH" || reply.intent === "NUH";
    const noCommands = cmds.length === 0;
    expectationOk = deferred && noCommands;
    if (!deferred) notes.push("expected to defer (HUH/NUH) on an ambiguous request");
    if (!noCommands) notes.push("expected NO commands on an ambiguous request");
  } else {
    expectationOk = (c.expect ?? []).every((e) => {
      const matches = cmds.filter((x) => x.command === e.command);
      if (matches.length === 0) { notes.push(`missing expected command "${e.command}"`); return false; }
      if (e.ref) {
        const grounded = matches.some((m) => {
          const a = (m.args ?? {}) as Record<string, unknown>;
          return ID_ARGS.some((k) => a[k] === e.ref);
        });
        if (!grounded) { notes.push(`"${e.command}" did not target ${e.ref}`); return false; }
      }
      return true;
    });
    if (cmds.length === 0) { expectationOk = false; notes.push("an action request produced no commands"); }
  }

  const pass = parsed && intentOk && commandsValid && expectationOk;
  return { id: c.id, parsed, intentOk, commandsValid, expectationOk, pass, reply, notes };
}
