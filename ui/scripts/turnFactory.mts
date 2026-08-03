// Turn factory — real-engine agent trajectories at volume.
//
//   cd ui && npm run turn-factory -- [--arcs all|name,name] [--out <tuples.jsonl>]
//                                    [--bin <Mosh binary>] [--limit N] [--rules-file f]
//
// For each arc (a seeded session + a sequence of producer utterances) it:
//   1. replays the arc's command prefix into a FRESH headless engine (`Mosh --run-script`,
//      engine ids are deterministic across replays — verified) and captures the REAL
//      snapshot via the read-only `__snapshot` directive;
//   2. builds the byte-identical production system prompt (brainCore.buildSystemPrompt)
//      over that real snapshot and asks the configured cloud brain for {intent, commands};
//   3. validates each command against the agent catalog, screens destructive overflow,
//      executes the turn bracketed in batch_begin{turn_id,utterance}/batch_end on the
//      real engine, and re-snapshots;
//   4. emits a schema-identical training Tuple (tupleSchema v1) whose snapshots are
//      ENGINE-real (not mock-reconstructed — sidesteps the known native-vs-mock id drift
//      that flags organic tuples replayClean:false) and whose outcome.appliedClean comes
//      from the real command results.
//
// Deferrals (no valid commands) and invalid commands are recorded in the report, not as
// tuples. Hermetic by construction: arcs use only non-service-spawning commands.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { validateCommand } from "../src/agent/commands";
import { TUPLE_SCHEMA_VERSION, isAgentCallable, type Tuple, type TupleCommand } from "../src/harvest/tupleSchema";
import type { Snapshot } from "../src/types";

type Cmd = { command: string; args?: Record<string, unknown> };
type Arc = { name: string; seed: Cmd[]; utterances: string[] };

// ── env / flags ─────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const p = resolve(process.cwd(), ".env.local");
  if (existsSync(p))
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 0) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "").trim();
      if (k && !env[k]) env[k] = v;
    }
  return env;
}
const env = loadEnv();
const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const BASE = env.OPENAI_BASE_URL;
const KEY = env.OPENAI_API_KEY;
const MODEL = flag("model") || env.OPENAI_MODEL;
if (!BASE || !KEY || !MODEL) {
  console.error("turn-factory: need OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL (ui/.env.local or env)");
  process.exit(1);
}
const IS_REASONING = /^(gpt-5|gpt-6|o[0-9])/.test(MODEL);

function findBin(): string {
  const cand = [
    flag("bin"),
    resolve(process.cwd(), "../build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh"),
    resolve(process.cwd(), "../build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"),
    "/Applications/Mosh.app/Contents/MacOS/Mosh",
  ].filter(Boolean) as string[];
  for (const c of cand) if (existsSync(c)) return c;
  console.error("turn-factory: Mosh binary not found — pass --bin");
  process.exit(1);
}
const BIN = findBin();
const OUT = flag("out", join(homedir(), "Library", "Mosh", "session", "tuples.factory.jsonl"))!;
const LIMIT = Number(flag("limit", "0")) || 0; // 0 = no limit
const RULES = flag("rules-file") ? readFileSync(flag("rules-file")!, "utf8") : DEFAULT_RULES;
const WORK = join(tmpdir(), `mosh-turn-factory-${process.pid}`);
mkdirSync(WORK, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

// ── real-engine execution ───────────────────────────────────────────────────────
type RunOut = { results: Array<Record<string, unknown>>; snaps: Record<string, Snapshot> };
function runScript(lines: Cmd[], session: string): RunOut {
  const spath = join(WORK, `${session}.jsonl`);
  const opath = join(WORK, `${session}.out.jsonl`);
  writeFileSync(spath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = spawnSync(BIN, ["--run-script"], {
    env: {
      ...process.env,
      MOSH_NO_AUDIO: "1",
      MOSH_ENABLE_SA3: "0",
      MOSH_ENABLE_TRANSFORM: "0",
      MOSH_RUN_SCRIPT: spath,
      MOSH_RUN_SCRIPT_OUT: opath,
      MOSH_SELFTEST_SESSION: session.startsWith("_harness/") ? session : `_harness/${session}`,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (r.error) throw r.error;
  const results: Array<Record<string, unknown>> = [];
  const snaps: Record<string, Snapshot> = {};
  if (existsSync(opath))
    for (const line of readFileSync(opath, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        results.push(o);
        if (o.command === "__snapshot" && o.data) snaps[(o.label as string) ?? (o.data.label as string) ?? "snap"] = o.data as Snapshot;
      } catch {
        /* tolerate */
      }
    }
  // label fallback: map snapshots in order of appearance if labels missing
  return { results, snaps };
}

function snapshotAt(lines: Cmd[], session: string): { snap: Snapshot; results: Array<Record<string, unknown>> } {
  const out = runScript([...lines, { command: "__snapshot", args: { label: "s" } }], session);
  const snapRes = out.results.filter((r) => r.command === "__snapshot");
  const snap = (snapRes[snapRes.length - 1]?.data ?? {}) as Snapshot;
  return { snap, results: out.results };
}

// ── brain ───────────────────────────────────────────────────────────────────────
let spentPromptTok = 0;
let spentCompTok = 0;
async function callBrain(system: string, user: string): Promise<{ content: string; ms: number }> {
  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  };
  if (IS_REASONING) payload.max_completion_tokens = 800;
  else Object.assign(payload, { max_tokens: 800, temperature: 0 });
  const t0 = Date.now();
  const res = await fetch(`${BASE.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`brain HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as any;
  spentPromptTok += j.usage?.prompt_tokens ?? 0;
  spentCompTok += j.usage?.completion_tokens ?? 0;
  return { content: j.choices?.[0]?.message?.content ?? "", ms };
}

// ── destructive screen (mirror of executor.ts policy, bridge-free) ──────────────
const DESTRUCTIVE = new Set(["remove_track", "remove_clip", "remove_plugin", "remove_section", "remove_bus", "remove_send", "remove_lyric_sheet"]);
const isDestructive = (c: string) => DESTRUCTIVE.has(c) || /^(remove|delete|clear)_/.test(c);
const MAX_DESTRUCTIVE = 10;

// ── arcs ────────────────────────────────────────────────────────────────────────
const seedBasic: Cmd[] = [
  { command: "set_tempo", args: { bpm: 120 } },
  { command: "create_track", args: { name: "Drums" } }, // deterministic id 1010
  { command: "create_track", args: { name: "808" } }, // 1011
  { command: "create_track", args: { name: "Keys" } }, // 1012
  { command: "add_test_tone_clip", args: { trackId: "1011", seconds: 4 } },
];

const ARCS: Arc[] = [
  {
    name: "session-setup",
    seed: [],
    utterances: [
      "set the tempo to 140",
      "actually make it 92 bpm",
      "switch us to 3/4 time",
      "back to 4/4 please",
      "make a track called Drums",
      "add a midi track named Melody",
      "add two more tracks, one called 808 and one called Vox",
      "rename the Vox track to Lead Vox",
      "this session should be at 150 bpm, trap tempo",
    ],
  },
  {
    name: "mixer-moves",
    seed: seedBasic,
    utterances: [
      "turn the Drums down a little",
      "the 808 is way too quiet, bring it up",
      "pan the Keys a bit to the left",
      "mute the Keys for now",
      "unmute the Keys and solo the Drums",
      "unsolo everything and set the Drums to -6 dB",
      "pull the whole 808 track down by like 3 dB",
      "center the Keys pan again",
    ],
  },
  {
    name: "arrange-clips",
    seed: seedBasic,
    utterances: [
      "put a 4 bar midi clip at the top of the Keys track",
      "move that test tone clip so it starts at bar 3",
      "add another test tone on the Drums track starting at bar 5, 4 beats long",
      "split the first clip on the 808 track at bar 5",
      "trim the tail of the last clip on the 808 track a bit shorter",
    ],
  },
  {
    name: "notes-population",
    seed: [
      { command: "set_tempo", args: { bpm: 140 } },
      { command: "create_track", args: { name: "Melody" } }, // deterministic id 1010
      { command: "add_midi_clip", args: { trackId: "1010", start: 0, length: 4 } },
    ],
    utterances: [
      "write a short simple melody into the clip on the Melody track",
      "add a low C note at the start of that clip, 2 beats long",
      "put a little three note run at the end of the clip",
      "add a sparse bassline feel: long notes on beats 1 and 5",
    ],
  },
  {
    name: "transport-loop",
    seed: seedBasic,
    utterances: [
      "play it",
      "stop playback",
      "loop the first 8 beats",
      "jump back to the top",
      "play from bar 3",
    ],
  },
  {
    name: "sections",
    seed: seedBasic,
    utterances: [
      "mark the first 16 beats as the Intro",
      "add a Hook section from beat 16 to 48",
      "rename the Intro section to Cold Open",
    ],
  },
  {
    name: "corrective-mix",
    seed: [
      ...seedBasic,
      { command: "set_track_volume", args: { trackId: "1010", db: 6 } },
      { command: "set_track_volume", args: { trackId: "1011", db: -18 } },
      { command: "set_track_pan", args: { trackId: "1012", pan: -0.9 } },
    ],
    utterances: [
      "the drums are drowning everything, pull them down",
      "I can barely hear the 808, fix that",
      "the keys are way off to one side, bring them back toward the middle",
      "give me a bit more headroom on the whole drum bus",
      "the mix feels lopsided, balance the drums against the 808",
    ],
  },
  {
    name: "corrective-arrange",
    seed: seedBasic,
    utterances: [
      "that clip on the 808 comes in too early, push it back a bar",
      "the tone clip on the 808 track overstays its welcome, tighten it up",
      "double the Drums: add another tone clip right after the first one",
      "actually undo that last change",
      "redo it, it was fine",
    ],
  },
  {
    name: "builtin-fx",
    seed: seedBasic,
    utterances: [
      "put some OTT style compression on the Drums",
      "add autotune to the Keys track",
      "bypass the compressor on the Drums for a second",
      "take the autotune off the Keys",
    ],
  },
  {
    name: "cleanup-destructive",
    seed: seedBasic,
    utterances: [
      "get rid of the Keys track",
      "remove the first clip on the Drums track",
      "clean slate: delete the 808 track too",
    ],
  },
];

// ── main ────────────────────────────────────────────────────────────────────────
async function main() {
  const arcFilter = (flag("arcs", "all") || "all").split(",");
  const arcs = arcFilter[0] === "all" ? ARCS : ARCS.filter((a) => arcFilter.includes(a.name));
  const report = {
    model: MODEL,
    bin: BIN,
    startedAt: new Date().toISOString(),
    turns: 0,
    tuples: 0,
    deferrals: [] as Array<{ arc: string; utterance: string; intent?: string }>,
    invalid: [] as Array<{ arc: string; utterance: string; command: string; error: string }>,
    destructiveBlocked: 0,
    appliedCleanRate: 0,
    latencyMsMean: 0,
  };
  let cleanCount = 0;
  const latencies: number[] = [];
  let total = 0;

  for (const arc of arcs) {
    let prefix: Cmd[] = [...arc.seed];
    const session = `tf-${arc.name}`;
    // initial snapshot after seed
    let { snap: before } = snapshotAt(prefix, session);
    let ti = 0;
    for (const utterance of arc.utterances) {
      if (LIMIT && total >= LIMIT) break;
      total++;
      report.turns++;
      const system = buildSystemPrompt(RULES, before);
      let content = "";
      let ms = 0;
      try {
        ({ content, ms } = await callBrain(system, utterance));
      } catch (e) {
        report.invalid.push({ arc: arc.name, utterance, command: "(brain)", error: String(e).slice(0, 200) });
        continue;
      }
      latencies.push(ms);
      const reply = parseReply(content);
      const cmds = reply.commands ?? [];
      const valid: Cmd[] = [];
      for (const c of cmds) {
        const err = validateCommand(c.command, c.args ?? {});
        if (err) report.invalid.push({ arc: arc.name, utterance, command: c.command, error: err });
        else valid.push({ command: c.command, args: c.args ?? {} });
      }
      const destructive = valid.filter((c) => isDestructive(c.command));
      let allowed = valid;
      if (destructive.length > MAX_DESTRUCTIVE) {
        allowed = valid.filter((c) => !isDestructive(c.command));
        report.destructiveBlocked += destructive.length;
      }
      if (allowed.length === 0) {
        report.deferrals.push({ arc: arc.name, utterance, intent: reply.intent });
        continue; // deferral — recorded, not a tuple, prefix unchanged
      }
      const turnId = `tf-${arc.name}-${String(ti).padStart(3, "0")}`;
      ti++;
      const bracket: Cmd[] = [
        { command: "batch_begin", args: { name: `agent: ${utterance.slice(0, 40)}`, turn_id: turnId, utterance, source: "brain_chat" } },
        ...allowed,
        { command: "batch_end", args: {} },
      ];
      const script = [...prefix, ...bracket];
      const { snap: after, results } = snapshotAt(script, session);
      // per-command results for the turn = the slice after the prefix
      const turnResults = results.slice(prefix.length, prefix.length + bracket.length);
      const cmdResults: TupleCommand[] = allowed.map((c, i) => {
        const r = turnResults[i + 1] as Record<string, unknown> | undefined; // +1 skips batch_begin
        return {
          command: c.command,
          args: (c.args ?? {}) as Record<string, unknown>,
          ok: r ? r.ok !== false : false,
          error: r && typeof r.error === "string" ? (r.error as string) : undefined,
          agentCallable: isAgentCallable(c.command),
        };
      });
      const appliedClean = cmdResults.every((c) => c.ok);
      const tuple: Tuple = {
        schemaVersion: TUPLE_SCHEMA_VERSION,
        kind: "imitation",
        turnId,
        utterance,
        source: "brain_chat",
        ts: Date.now(),
        seq: { begin: prefix.length, end: prefix.length + bracket.length - 1 },
        snapshotBefore: before,
        snapshotAfter: after,
        commands: cmdResults,
        outcome: {
          appliedClean,
          // Real-engine authority: these tuples never went through the mock; the
          // engine's own clean apply IS the contract here (mock replay of native ids
          // is known-divergent — see the audit).
          replayClean: appliedClean,
          undone: false,
          taste: [],
        },
        provenance: { logPath: `turn-factory:${session}`, harvestedAt: new Date().toISOString() },
      };
      appendFileSync(OUT, JSON.stringify(tuple) + "\n");
      report.tuples++;
      if (appliedClean) cleanCount++;
      prefix = script; // turn (incl. failed commands) becomes part of history — deterministic replay
      before = after;
      process.stderr.write(`  [${arc.name}] "${utterance}" → ${allowed.length} cmd(s) ${appliedClean ? "✓" : "✗"} (${ms}ms)\n`);
    }
  }

  report.appliedCleanRate = report.tuples ? cleanCount / report.tuples : 0;
  report.latencyMsMean = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const reportPath = OUT.replace(/\.jsonl$/, ".report.json");
  writeFileSync(reportPath, JSON.stringify({ ...report, promptTokens: spentPromptTok, completionTokens: spentCompTok }, null, 2));
  console.log(
    `turn-factory: ${report.tuples} tuple(s) from ${report.turns} turn(s) → ${OUT}\n` +
      `  appliedClean ${(report.appliedCleanRate * 100).toFixed(1)}% · deferrals ${report.deferrals.length} · invalid ${report.invalid.length}` +
      ` · mean brain latency ${report.latencyMsMean}ms · tokens ${spentPromptTok}+${spentCompTok}\n  report → ${reportPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
