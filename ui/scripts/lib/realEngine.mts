// Shared real-engine + brain glue for the offline training/eval runners
// (turnFactory.mts, moshiBench.mts). Pure Node — no bridge/window deps.
//
// Execution model: `Mosh --run-script` spawns a FRESH headless engine per
// invocation (state does not persist across runs); engine-assigned ids are
// deterministic across replays of the same command prefix (verified 2026-07-01),
// so cumulative-prefix replay is sound. The read-only `__snapshot` directive
// returns the same ops.snapshot() the WebView sees.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Snapshot } from "../../src/types";

export type Cmd = { command: string; args?: Record<string, unknown>; capture?: Record<string, string> };

export function loadEnv(): Record<string, string> {
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

export function argFlag(n: string, d?: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

export function findBin(explicit?: string): string {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(`Mosh binary not found at --bin ${explicit}`);
  }
  // NEWEST binary wins (2026-07 audit: a stale worktree build silently ignored
  // assign_sample mode:"melodic" and shipped sine renders — path priority is a trap).
  const cand = [
    resolve(process.cwd(), "../build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh"),
    resolve(process.cwd(), "../build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"),
    "/Applications/Mosh.app/Contents/MacOS/Mosh",
  ].filter((c) => existsSync(c));
  if (cand.length === 0) throw new Error("Mosh binary not found — pass --bin");
  cand.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return cand[0];
}

const WORK = join(tmpdir(), `mosh-real-engine-${process.pid}`);
mkdirSync(WORK, { recursive: true });

export type RunOut = { results: Array<Record<string, unknown>>; raw: ReturnType<typeof spawnSync> };

export function runScript(bin: string, lines: Cmd[], session: string, timeoutMs = 180_000): RunOut {
  const spath = join(WORK, `${session}.jsonl`);
  const opath = join(WORK, `${session}.out.jsonl`);
  writeFileSync(spath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const raw = spawnSync(bin, ["--run-script"], {
    env: {
      ...process.env,
      MOSH_NO_AUDIO: "1",
      MOSH_ENABLE_SA3: "0",
      MOSH_ENABLE_TRANSFORM: "0",
      MOSH_RUN_SCRIPT: spath,
      MOSH_RUN_SCRIPT_OUT: opath,
      MOSH_SELFTEST_SESSION: session,
    },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (raw.error) throw raw.error;
  const results: Array<Record<string, unknown>> = [];
  if (existsSync(opath))
    for (const line of readFileSync(opath, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        results.push(JSON.parse(s));
      } catch {
        /* tolerate garbage lines */
      }
    }
  return { results, raw };
}

/** Run `lines` + a trailing __snapshot; return the final snapshot and all results.
 *  A short __wait lets async state (transport flags) settle before the snapshot. */
export function snapshotAt(bin: string, lines: Cmd[], session: string): { snap: Snapshot; results: Array<Record<string, unknown>> } {
  const out = runScript(bin, [...lines, { command: "__wait", args: { ms: 250 } }, { command: "__snapshot", args: { label: "s" } }], session);
  const snaps = out.results.filter((r) => r.command === "__snapshot");
  const snap = (snaps[snaps.length - 1]?.data ?? {}) as Snapshot;
  return { snap, results: out.results };
}

// ── OpenAI-compatible brain call (mirrors BrainProxy/vite proxy payload shape) ──
export type BrainConfig = { base: string; key: string; model: string };
export type BrainUsage = { promptTokens: number; completionTokens: number; calls: number };

export function brainConfigFromEnv(env: Record<string, string>, modelOverride?: string): BrainConfig {
  const base = env.OPENAI_BASE_URL;
  const key = env.OPENAI_API_KEY;
  const model = modelOverride || env.OPENAI_MODEL;
  if (!base || !key || !model) throw new Error("need OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL (ui/.env.local or env)");
  return { base, key, model };
}

// ── claude-CLI transport (Claude Code subscription auth — no API key) ─────────
// Shells out to `claude -p`: the system message goes via --system-prompt-file
// (REPLACES the CLI's default system prompt), the conversation arrives on
// stdin, and --output-format json returns {result, usage, is_error}. The child
// runs in an EMPTY scratch cwd so no CLAUDE.md/project context leaks into the
// seat, and the core tools are disallowed — the seat answers from the prompt
// alone, exactly like every HTTP seat in the sweep. There is no
// response_format here; parseLoopReply/brainCore already strip code fences.
// Auth note: an expired OAuth token surfaces as is_error + "401" in result —
// thrown as an error so the bench records it instead of grading garbage.
const CLI_TOOL_DENY = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch",
  "Task", "TodoWrite", "NotebookEdit",
];

export function callClaudeCli(
  model: string,
  messages: Array<{ role: string; content: string }>,
  usage?: BrainUsage,
): { content: string; ms: number } {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const prompt = rest.length === 1
    ? rest[0].content
    : rest.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");

  const dir = join(WORK, "claude-cli");
  mkdirSync(dir, { recursive: true });
  const sysPath = join(dir, `sys-${process.hrtime.bigint()}.txt`);
  writeFileSync(sysPath, sys);
  const t0 = Date.now();
  const raw = spawnSync("claude", [
    "-p", "--model", model,
    "--no-session-persistence", "--output-format", "json",
    "--system-prompt-file", sysPath,
    "--disallowedTools", ...CLI_TOOL_DENY,
  ], { cwd: dir, input: prompt, encoding: "utf8", timeout: 300_000 });
  const ms = Date.now() - t0;
  rmSync(sysPath, { force: true });
  if (raw.error) throw raw.error;

  // -p --output-format json emits exactly one JSON envelope on stdout.
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(String(raw.stdout).trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`claude-cli: unparseable output (exit ${raw.status}): ` +
      `${String(raw.stdout).slice(0, 200)} | ${String(raw.stderr).slice(0, 200)}`);
  }
  if (j.is_error) throw new Error(`claude-cli: ${String(j.result).slice(0, 300)}`);
  const u = (j.usage ?? {}) as Record<string, number>;
  if (usage) {
    usage.promptTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.completionTokens += u.output_tokens ?? 0;
    usage.calls += 1;
  }
  return { content: String(j.result ?? ""), ms };
}

// ── codex-CLI transport (ChatGPT/Codex subscription auth — no API key) ────────
// Shells out to `codex exec` in an empty ephemeral cwd (--ignore-user-config,
// read-only sandbox, --color never). Codex has NO system-prompt override, so
// the system message is delivered inline at the top of the user prompt under a
// [system] marker — the ~15k-token Codex harness prompt still wraps the seat.
// That makes this seat shape DIFFERENT from the HTTP sweep: always run a
// cross-transport control (a model with an existing OpenRouter board) before
// trusting comparisons. Usage + the final agent_message come from --json events.
export function callCodexCli(
  model: string,
  messages: Array<{ role: string; content: string }>,
  usage?: BrainUsage,
): { content: string; ms: number } {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const convo = rest.length === 1
    ? rest[0].content
    : rest.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  // Seat variants (MOSH_CODEX_SEAT):
  //   inline   — system delivered as a [system] block inside the user prompt.
  //              Measured cost on the 5.6-sol control: 58.8% vs 67.6% OpenRouter,
  //              wrong-defers 4→7 — the Codex harness persona outranks quoted text.
  //   agentsmd — system written to AGENTS.md in the scratch cwd (codex's native
  //              instructions channel, doc-level authority); user turn stays pure.
  // NB: the trailing guard must never say "commands" — that's the reply
  // contract's field name, and a "do not run commands" phrasing measurably
  // makes models defer (caught live on gpt-5.4: WRONG-DEFER on a clear ask).
  // MOSH_CODEX_EFFORT maps to `-c model_reasoning_effort=…` (low|medium|high|
  //   xhigh). --ignore-user-config drops codex to its default effort, which
  //   under-represents the owner's real config (xhigh) — set it explicitly when
  //   benching what the subscription actually serves day-to-day.
  const seat = process.env.MOSH_CODEX_SEAT ?? "inline";
  const effort = process.env.MOSH_CODEX_EFFORT;
  const guard = `Answer directly with the JSON object described in the instructions — output nothing else and do not use any tools.`;
  const dir = join(WORK, `codex-cli-${seat}`);
  mkdirSync(dir, { recursive: true });
  let prompt: string;
  if (seat === "agentsmd") {
    writeFileSync(join(dir, "AGENTS.md"), sys);
    prompt = `${convo}\n\n${guard}`;
  } else {
    prompt = `[system]\n${sys}\n\n[user]\n${convo}\n\n${guard}`;
  }
  const t0 = Date.now();
  const raw = spawnSync("codex", [
    "exec", "-m", model,
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
    "-s", "read-only", "--color", "never", "--json", "-",
  ], { cwd: dir, input: prompt, encoding: "utf8", timeout: 600_000 });
  const ms = Date.now() - t0;
  if (raw.error) throw raw.error;

  let text: string | undefined;
  const errors: string[] = [];
  for (const line of String(raw.stdout).split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as Record<string, any>;
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = String(ev.item.text ?? "");
      if (ev.type === "turn.completed" && usage && ev.usage) {
        usage.promptTokens += ev.usage.input_tokens ?? 0;
        usage.completionTokens += ev.usage.output_tokens ?? 0;
        usage.calls += 1;
      }
      if (ev.type === "error" || ev.type === "turn.failed")
        errors.push(JSON.stringify(ev).slice(0, 300));
    } catch { /* tolerate non-JSON stdout lines */ }
  }
  if (text === undefined) {
    throw new Error(`codex-cli: no agent_message (exit ${raw.status}): ` +
      `${errors.join(" | ") || String(raw.stderr).slice(0, 300)}`);
  }
  return { content: text, ms };
}

export async function callBrain(
  cfg: BrainConfig,
  messages: Array<{ role: string; content: string }>,
  usage?: BrainUsage,
  opts?: { noThink?: boolean; maxTokens?: number },
): Promise<{ content: string; ms: number }> {
  const isReasoning = /^(gpt-5|gpt-6|o[0-9])/.test(cfg.model);
  // 800 is the shipped BrainProxy cap and stays the default; always-on-thinking
  // models (Fable/K3/…) spend the cap on reasoning tokens and return truncated
  // or empty JSON at 800 — sweeps raise it via opts.maxTokens.
  const cap = opts?.maxTokens ?? 800;
  const payload: Record<string, unknown> = { model: cfg.model, messages, response_format: { type: "json_object" } };
  if (isReasoning) payload.max_completion_tokens = cap;
  else Object.assign(payload, { max_tokens: cap, temperature: 0 });
  // local mlx_lm thinking models only — cloud APIs reject unknown fields, so flag-gated
  if (opts?.noThink) payload.chat_template_kwargs = { enable_thinking: false };
  const t0 = Date.now();
  const res = await fetch(`${cfg.base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(payload),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`brain HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as any;
  if (usage) {
    usage.promptTokens += j.usage?.prompt_tokens ?? 0;
    usage.completionTokens += j.usage?.completion_tokens ?? 0;
    usage.calls += 1;
  }
  return { content: j.choices?.[0]?.message?.content ?? "", ms };
}
