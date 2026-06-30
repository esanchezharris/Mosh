// Audio audition — drive a served SFT model (owner-v1 vs v2) through multi-turn beat-build
// scripts, then render each build to a WAV so the owner can A/B "which is more my style".
//
// The model emits commands referencing the ids it sees in ITS snapshot (the mock's sequential
// "1","2",…). The native engine assigns its OWN ids, so we drive the SAME mock that builds each
// turn's prompt and, as each command executes, convert it to a native `--run-script` line with the
// capture mechanism (create_* → {"capture":{"vN":"trackId"}}, later id refs → "${vN}"). The full
// accumulated build (all turns) + export_audio = one render program. Mirrors buildRenderProgram's
// remap, generalized across turns (the agent's whole build goes in the capture path).
//
//   serve a model:  HF_HUB_OFFLINE=1 python -m mlx_lm server --model <4bit> --adapter-path <ad> --port 8081
//   then:           AUDITION_PORT=8081 npm run tsx scripts/auditionImitation.mts -- --tag owner-v1 --out ~/mosh-imitation-audition

import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../src/bridge.mock";
import { systemPrompt, parseReply } from "../src/agent/brainCore";
import type { Snapshot, CommandResult } from "../src/types";

type Line = { command: string; args: Record<string, unknown>; capture?: Record<string, string> };

const arg = (k: string, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TAG = arg("tag", "model");
const OUT = arg("out", join(process.env.HOME!, "mosh-imitation-audition"));
const PORT = process.env.AUDITION_PORT ?? "8081";
const MOSH_BIN = process.env.MOSH_BIN ?? "/Applications/Mosh.app/Contents/MacOS/Mosh";

// build scripts: each a sequence of turn utterances that construct one beat
// Turns are phrased to ELICIT NOTE PATTERNS (not just empty clips): the SFT taught note-writing as
// "write a pattern into the clip" examples, so each turn asks for the actual notes, not just a track.
const SCRIPTS: { id: string; turns: string[] }[] = [
  { id: "dark_trap", turns: ["set the tempo to 140 and make a drum track, then write a hard trap pattern with kick, snare and rolling hi-hats", "add an 808 bass track and write a deep bassline in a minor key", "add a melody track and write a dark melody"] },
  { id: "lofi", turns: ["set a chill tempo around 82 and make a drum track with a mellow boom-bap pattern", "add a bass track and write a warm bassline", "add a keys track and write soft jazzy chords"] },
  { id: "rolling_trap", turns: ["make a drum track and write a trap beat with fast rolling hi-hats, kick and snare", "add an 808 track and write a bassline in a minor key", "add a bell track and write a bright melody"] },
  { id: "boombap", turns: ["make a drum track and write a boom-bap pattern with a punchy kick and snare", "add a bass track and write a groovy bassline", "add a keys track and write a soulful chord melody"] },
  { id: "aggressive", turns: ["make a drum track and write an aggressive trap pattern with punchy kicks and snares", "add an 808 track and write a hard distorted-feel bassline", "add a lead track and write a tense melody"] },
];

const isIdKey = (k: string) => /id$/i.test(k);
const captureField = (cmd: string) => (cmd === "create_track" || cmd === "create_group" ? "trackId" : "clipId");

async function callBrain(messages: { role: string; content: string }[]): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens: 600, temperature: 0.7 }),  // no model field → mlx_lm 404s on a mismatch
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

async function buildOne(turns: string[]): Promise<{ lines: Line[]; nCmds: number; deferred: number }> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const idToVar = new Map<string, string>();
  const lines: Line[] = [];
  const history: { role: string; content: string }[] = [];
  let counter = 0, nCmds = 0, deferred = 0;

  for (const utt of turns) {
    const snap = await mockSnapshot<Snapshot>();
    const messages = [{ role: "system", content: systemPrompt(snap) }, ...history.slice(-6), { role: "user", content: utt }];
    let content = "";
    try { content = await callBrain(messages); } catch { content = ""; }
    const cmds = parseReply(content).commands ?? [];
    if (cmds.length === 0) deferred++;
    for (const c of cmds) {
      const raw = { command: c.command, args: (c.args ?? {}) as Record<string, unknown> };
      let res: any = null;
      try { res = await mockExecute<CommandResult>(raw); } catch { res = { ok: false }; }
      // remap id-args that point at an already-created entity → ${var}
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw.args)) {
        args[k] = isIdKey(k) && typeof v === "string" && idToVar.has(v) ? `\${${idToVar.get(v)}}` : v;
      }
      const line: Line = { command: raw.command, args };
      // mockExecute returns the FLATTENED envelope (ok(cmd,{trackId}) → {ok,command,trackId}), not nested .data
      const newId = res?.ok ? (res?.trackId ?? res?.clipId ?? res?.data?.trackId ?? res?.data?.clipId ?? res?.id) : undefined;
      if (newId != null && (raw.command === "create_track" || raw.command === "create_group" || /clip/i.test(raw.command))) {
        const v = `v${counter++}`;
        idToVar.set(String(newId), v);
        line.capture = { [v]: captureField(raw.command) };
      }
      lines.push(line);
      if (res?.ok) nCmds++;
    }
    history.push({ role: "user", content: utt }, { role: "assistant", content });
  }
  return { lines, nCmds, deferred };
}

function render(lines: Line[], wav: string, session: string): { ok: boolean; err?: string } {
  const script = lines.map((l) => JSON.stringify(l)).concat(JSON.stringify({ command: "export_audio", args: { file: wav, format: "wav" } })).join("\n");
  const sf = wav.replace(/\.wav$/, ".script.jsonl");
  writeFileSync(sf, script + "\n");
  const r = spawnSync(MOSH_BIN, ["--run-script"], { env: { ...process.env, MOSH_RUN_SCRIPT: sf, MOSH_SELFTEST_SESSION: session }, encoding: "utf8", timeout: 180000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const fail = out.match(/(\d+) failure\(s\)/);
  return { ok: r.status === 0 && (!fail || fail[1] === "0" || out.includes('"command": "export_audio"') && !out.includes('export_audio", "error')), err: out.slice(-200) };
}

async function main() {
  const dir = join(OUT, TAG);
  mkdirSync(dir, { recursive: true });
  const manifest: any[] = [];
  for (const s of SCRIPTS) {
    const { lines, nCmds, deferred } = await buildOne(s.turns);
    const wav = join(dir, `${s.id}.wav`);
    const r = render(lines, wav, `aud_${TAG}_${s.id}`);
    console.log(`  ${TAG}/${s.id}: ${nCmds} cmds, ${deferred} defers, render ${r.ok ? "OK" : "FAIL " + r.err}`);
    manifest.push({ tag: TAG, script: s.id, wav, nCmds, deferred, renderOk: r.ok, turns: s.turns });
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`wrote ${manifest.length} renders → ${dir}`);
}

main();
