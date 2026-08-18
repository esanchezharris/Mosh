// The loop's demo/e2e brain — the multi-step sibling of brainMock.ts. The explicit
// Vite/e2e surface may use it after a provider failure so the drawer, Stop and
// task-undo remain hermetic. Packaged builds never call it. Deterministic: keyed
// on the TASK line of the loop's task-context message.

import type { ChatMessage } from "./loop";

const reply = (o: Record<string, unknown>) => ({ content: JSON.stringify(o), ms: 0 });

function taskOf(messages: ChatMessage[]): string {
  const user = messages[messages.length - 1]?.content ?? "";
  return (user.match(/^TASK: (.*)$/m)?.[1] ?? "").toLowerCase();
}

function modeOf(messages: ChatMessage[]): "plan" | "compile" | "other" {
  const user = messages[messages.length - 1]?.content ?? "";
  // Matched on a stable SUBSTRING, not an anchored sentence: MODE_INSTRUCTION.plan
  // leads with the act-vs-defer gate ("Does the TASK name a concrete thing and
  // direction…? … Otherwise make a plan"), so a ^-anchored match silently fell
  // through to "other" and the script ended at step 0. Every plan phrasing has
  // contained "make a plan"; compile/repair/continue contain none of it.
  if (/make a plan/i.test(user)) return "plan";
  if (/give the commands for the next step/i.test(user)) return "compile";
  return "other";
}

/** Deterministic multi-step scripts for the preview/e2e loop. */
export function mockLoopChat(messages: ChatMessage[]): { content: string; ms: number } {
  const task = taskOf(messages);
  const mode = modeOf(messages);

  // "build me a lofi sketch" / "make a beat" — a two-step flow that exercises
  // plan → inline step → OBSERVE → compile.
  if (/\b(lofi|lo-fi|beat|sketch)\b/.test(task)) {
    if (mode === "plan")
      return reply({
        intent: "ACK_WORKING", say: "dusty beat coming up", status: "continue",
        plan: [
          { goal: "set a lazy tempo", commands: [{ command: "set_tempo", args: { bpm: 80 } }] },
          { goal: "lay dusty drums" },
        ],
      });
    if (mode === "compile")
      return reply({
        intent: "ACK_GOT_IT", status: "continue",
        commands: [{ command: "add_drum_pattern", args: { pattern: "kick: x....x.....x....; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x." } }],
      });
    return reply({ intent: "DONE", say: "there's your sketch", status: "done" });
  }

  // Everything else: an honest park, in character.
  return reply({ intent: "HUH", say: "tell me more — what are we making?", status: "need_user" });
}
