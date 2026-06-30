// The Python↔TS reward bridge for the GRPO loop — RECIPE reward (Rung-1.5, the owner's
// reframe). Reads policy rollouts and scores each by the DETERMINISTIC recipe verifier over
// the musical DNA the rollout builds (parse reply → drive the mock → recipeFromSnapshot →
// verifyRecipe), NOT clean-apply and NOT audio. Same stdin-file/file-out contract as
// scoreRollouts.mts, so the mlx trainer swaps it via MOSH_RL_REWARD=recipe with no trainer change.
//
//   npx tsx scripts/rl/scoreRolloutsRecipe.mts --eval rl_train.eval.jsonl \
//       --rollouts step.rollouts.jsonl --out step.rewards.jsonl
//
// rollouts.jsonl : {"exId","sampleId","content":"<model reply>"}
// rewards.jsonl  : {"sampleId","reward":0..1,"deferred":bool}   (reward = verifyRecipe total)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../../src/bridge.mock";
import { parseReply } from "../../src/agent/brainCore";
import { verifyRecipe, recipeFromSnapshot } from "../../src/agent/recipeVerifier";
import type { Snapshot, CommandResult } from "../../src/types";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const rolloutsPath = flag("rollouts");
const outPath = flag("out");
if (!rolloutsPath || !existsSync(rolloutsPath)) { console.error(`--rollouts <jsonl> required (got ${rolloutsPath})`); process.exit(1); }
if (!outPath) { console.error("--out <rewards.jsonl> required"); process.exit(1); }

// Models prepend prose/emotes ("_chirp_", "<think>…") before the JSON → extract the first
// balanced {…} so parseReply sees the command object regardless of preamble.
function extractJson(s: string): string {
  const i = s.indexOf("{");
  if (i < 0) return s;
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return s.slice(i, k + 1); }
  }
  return s.slice(i);
}

const rollouts = readFileSync(rolloutsPath, "utf8").split("\n").filter((s) => s.trim()).map((l) => JSON.parse(l) as { exId: string; sampleId: string; content: string });

const newId = (res: any): string | undefined => res?.data?.trackId ?? res?.trackId ?? res?.data?.clipId ?? res?.clipId ?? res?.data?.id ?? res?.id;

const out: string[] = [];
for (const r of rollouts) {
  let reward = 0, deferred = true, note = "";
  try {
    __resetMockForTests();
    await mockExecute<CommandResult>({ command: "new_project", args: {} });
    const cmds = parseReply(extractJson(r.content ?? "")).commands ?? [];
    deferred = cmds.length === 0;
    // Order-based id-remap: the policy can't know the engine's clip/track ids in a one-shot
    // reply, so a literal id guess makes add_note fail and no notes land (everything scores
    // ~empty → flat reward → no gradient). The real system BINDS ids for the model; the musical
    // skill is note-WRITING. So remap unresolved trackId→last track, clipId→last clip, letting
    // the verifier grade the DNA the rollout actually describes (note content), not id luck.
    const tracks: string[] = [], clips: string[] = [];
    for (const c of cmds) {
      const args: Record<string, unknown> = { ...((c.args ?? {}) as Record<string, unknown>) };
      if (c.command === "add_midi_clip" && !(typeof args.trackId === "string" && tracks.includes(args.trackId)) && tracks.length) args.trackId = tracks[tracks.length - 1];
      if (c.command === "add_note" && !(typeof args.clipId === "string" && clips.includes(args.clipId)) && clips.length) args.clipId = clips[clips.length - 1];
      let res: any = null;
      try { res = await mockExecute<CommandResult>({ command: c.command, args }); } catch { res = null; }
      const id = res?.ok ? newId(res) : undefined;
      if (id != null) { if (c.command === "create_track" || c.command === "create_group") tracks.push(String(id)); else if (/clip/i.test(c.command)) clips.push(String(id)); }
    }
    if (!deferred) {
      const snap = await mockSnapshot<Snapshot>();
      reward = verifyRecipe(recipeFromSnapshot(snap)).total;
    }
  } catch (e) { note = String((e as Error)?.message ?? e); }
  out.push(JSON.stringify({ sampleId: r.sampleId, reward, deferred, feedback: note }));
}
writeFileSync(outPath, out.join("\n") + "\n");
console.log(`scored ${rollouts.length} rollouts (recipe verifier) → ${outPath}`);
