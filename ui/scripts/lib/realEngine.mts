// Shared real-engine + brain glue for the offline training/eval runners
// (turnFactory.mts, moshiBench.mts). Pure Node — no bridge/window deps.
//
// Execution model: `Mosh --run-script` spawns a FRESH headless engine per
// invocation (state does not persist across runs); engine-assigned ids are
// deterministic across replays of the same command prefix (verified 2026-07-01),
// so cumulative-prefix replay is sound. The read-only `__snapshot` directive
// returns the same ops.snapshot() the WebView sees.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

export async function callBrain(
  cfg: BrainConfig,
  messages: Array<{ role: string; content: string }>,
  usage?: BrainUsage,
  opts?: { noThink?: boolean },
): Promise<{ content: string; ms: number }> {
  const isReasoning = /^(gpt-5|gpt-6|o[0-9])/.test(cfg.model);
  const payload: Record<string, unknown> = { model: cfg.model, messages, response_format: { type: "json_object" } };
  if (isReasoning) payload.max_completion_tokens = 800;
  else Object.assign(payload, { max_tokens: 800, temperature: 0 });
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
