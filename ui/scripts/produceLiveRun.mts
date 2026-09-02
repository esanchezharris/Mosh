#!/usr/bin/env -S ui/node_modules/.bin/vite-node --mode development
// ONE produce-lane run against the LIVE Mosh app, driven over the native
// RemoteCompanionServer HTTP surface (port 47873 by default — the same server
// the phone controller and design-lab feed use; see scripts/produce-lane/
// README.md for the full launch sequence). This is deliberately NOT a bench
// replay: it drives a real running instance, so save_as/export_audio land
// real files under the session the owner can audition in the morning.
//
// MUST run under vite-node (`ui/node_modules/.bin/vite-node --mode development`),
// never tsx or plain node: ui/src/store.ts (and anything that transitively
// imports it) reads `import.meta.env` at module scope AND pulls in the native
// bridge's juce/check_native_interop.js, which throws `window is not defined`
// outside a WebView — verified directly (see scratchpad probe, 2026-09-02).
// For that reason this script does NOT import
// ui/src/agent/loop/taskExec.ts's createTaskExecutor (it hardcodes
// `useStore.getState().snapshot`); it re-implements the same undo-bracket +
// catalog-validate + destructive-screen contract locally
// (makeLocalTaskExecutor below) against the companion HTTP client instead of
// the store's exec/refresh. Everything else — runAgentLoop, the produce
// system prompt, the command catalog, the destructive screen — is the exact
// production code, imported unmodified from ui/src/agent.
//
// Usage:
//   ui/node_modules/.bin/vite-node --mode development ui/scripts/produceLiveRun.mts \
//     --url http://127.0.0.1:47873 --token <lab-token> \
//     --ask "produce a dark jerk trap beat at 148 in D minor" \
//     --run-id r1 --out-dir ~/Library/Mosh/produce-ab/2026-09-02/runs/r1 \
//     [--mock-brain] [--brain shim|openrouter] [--model sonnet|opus] \
//     [--timeout-ms 20000] [--hard-timeout-ms 720000] [--no-preflight] \
//     [--seed <n>] [--no-repair] \
//     [--pid <app pid, for RSS sampling>] [--dry-run]
//
// --seed (round 2 correction note 2 — "no variation in the synth sounds
// across runs"): threaded into runProduceTemplate's drum/808/synth-preset
// picking (drumPalette.ts). Defaults to an FNV-1a hash of --run-id, so two
// runs never silently share the pre-round-2 constant-0 seed just because the
// caller forgot the flag — overnight.sh passes a distinct seed (its own
// run index) per run explicitly.
//
// --no-repair (R2.4 driver half — see tryLoadProduceCheck below): skip the
// post-loop produceCheck pass entirely. The check+repair hook itself degrades the same
// way the W2.5 preflight does when its dependency isn't landed yet: a dynamic,
// try/catch-guarded import of produceCheck.ts, silently skipped (not a
// failure) when that file doesn't exist on this worktree.
//
// `--dry-run` resolves and prints the full config as JSON and exits 0 WITHOUT
// touching the companion server — the only mode safe to run with no app up.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { makeCompanionClient, wavRmsDbfs, type CommandResult, type CompanionClient } from "./lib/companionClient.mts";
import { validateCommand } from "../src/agent/commands";
import {
  DESTRUCTIVE_BLOCK_REASON, MAX_DESTRUCTIVE_PER_BATCH, destructiveWeight, isDestructiveCommand,
  type AgentCommandCall,
} from "../src/agent/destructiveScreen";
import { RENDER_JOB_COMMANDS, awaitRendersSettled } from "../src/agent/loop/jobWait";
import { runAgentLoop, type ChatMessage, type LoopProgressEvent } from "../src/agent/loop/loop";
import { mockLoopChat } from "../src/agent/loop/loopBrainMock";
import { PRODUCE_BUDGETS, buildProduceSystemPrompt } from "../src/agent/loop/producePrompt";
import type { AgentEnv, StepCommandResult } from "../src/agent/loopSeam";
// `import type` is erased at runtime (esbuild/vite-node drop it entirely, no
// module resolution attempted) — safe even on a worktree where W2.5 hasn't
// landed yet, unlike the dynamic `import()` below which is deliberately
// try/catch-guarded for exactly that case.
import type { ProduceTemplate, ProduceTemplateDeps } from "../src/agent/loop/produceTemplate";
// Same erased-at-runtime reasoning for R2.4's repair hook — produceCheck.ts is
// another agent's file; tryLoadProduceCheck below still dynamic-imports the
// VALUES behind a try/catch, but the types are safe to name directly here.
import type { CheckInput, CheckReport } from "../src/agent/loop/produceCheck";
import type { Snapshot } from "../src/types";
import type { PaletteItem } from "../src/agent/loop/drumPalette";

// ── args ────────────────────────────────────────────────────────────────────

function argFlag(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function argBool(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function readTokenFile(path: string): string {
  return readFileSync(path, "utf8").trim();
}

const URL = argFlag("url", "http://127.0.0.1:47873")!;
const TOKEN_FLAG = argFlag("token");
const TOKEN_FILE = argFlag("token-file");
const ASK = argFlag("ask");
const RUN_ID = argFlag("run-id", `r-${Date.now()}`)!;
const OUT_DIR_ARG = argFlag("out-dir");
const MOCK_BRAIN = argBool("mock-brain");
const BRAIN_PRIMARY = (argFlag("brain", "shim") as "shim" | "openrouter");
const MODEL = argFlag("model", "sonnet")!;
const TIMEOUT_MS = Number(argFlag("timeout-ms", "20000"));
const HARD_TIMEOUT_MS = Number(argFlag("hard-timeout-ms", "720000"));
const NO_PREFLIGHT = argBool("no-preflight");
const NO_REPAIR = argBool("no-repair");
const DRY_RUN = argBool("dry-run");
const APP_PID = argFlag("pid");
const SEED_FLAG = argFlag("seed");

const TOKEN = TOKEN_FLAG ?? (TOKEN_FILE && existsSync(TOKEN_FILE) ? readTokenFile(TOKEN_FILE) : undefined);
const OUT_DIR = OUT_DIR_ARG ? resolve(OUT_DIR_ARG) : undefined;

// FNV-1a over the run id — deterministic (same --run-id ⇒ same default seed,
// useful for a --dry-run sanity check) but decorrelated ACROSS run ids, which
// is the property that actually matters here: two runs in the same overnight
// batch must not silently collide on seed 0 (drumPalette.ts's picker was
// hard-defaulted to that before round 2 — the root cause of note 2).
function fnv1aHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const SEED = SEED_FLAG !== undefined ? Number(SEED_FLAG) : fnv1aHash(RUN_ID);

const resolvedConfig = {
  url: URL,
  ask: ASK ?? null,
  runId: RUN_ID,
  outDir: OUT_DIR ?? null,
  mockBrain: MOCK_BRAIN,
  brainPrimary: BRAIN_PRIMARY,
  model: MODEL,
  timeoutMs: TIMEOUT_MS,
  hardTimeoutMs: HARD_TIMEOUT_MS,
  preflight: !NO_PREFLIGHT,
  repair: !NO_REPAIR,
  seed: SEED,
  tokenPresent: !!TOKEN,
  pid: APP_PID ?? null,
};

if (DRY_RUN) {
  console.log(JSON.stringify({ dryRun: true, config: resolvedConfig }, null, 2));
  process.exit(0);
}

if (!TOKEN) throw new Error("produceLiveRun: need --token or --token-file <path holding the lab token>");
if (!ASK) throw new Error("produceLiveRun: need --ask \"<the production request>\"");
if (!OUT_DIR) throw new Error("produceLiveRun: need --out-dir <run directory>");
mkdirSync(OUT_DIR, { recursive: true });

// ── brain: the SAME HTTP path the app itself uses ──────────────────────────
// shim = claude -p via the local OpenAI-compatible shim (W1.3, port 8788 by
// default); openrouter = the real OpenRouter API. Never the local assistant
// model — produce mode is cloud-only by owner decision (see producePrompt.ts's
// header). `--mock-brain` swaps in the deterministic loop brain used by the
// dev/e2e surface, for smoke-testing this driver without spending real tokens.

const brainErrors: string[] = [];

// Token/cost accounting — the shim (`claude -p` under the owner's Claude Code
// subscription) is NOT per-token billed, so its calls cost $0 by construction;
// OpenRouter calls are, and overnight.sh sums this run's (and every other
// run's) `costUsd` against its --openrouter-cap-usd budget. Rates are a rough
// per-run estimate (plan: "Sonnet 5 ≈ $0.35/run"), not a billing source of
// truth — override via env if OpenRouter's posted rate drifts.
const PRICE_PER_M_TOKENS: Record<string, { in: number; out: number }> = {
  "anthropic/claude-sonnet-5": {
    in: Number(process.env.MOSH_PRICE_SONNET_IN_PER_M ?? "3"),
    out: Number(process.env.MOSH_PRICE_SONNET_OUT_PER_M ?? "15"),
  },
  "anthropic/claude-opus-5": {
    in: Number(process.env.MOSH_PRICE_OPUS_IN_PER_M ?? "15"),
    out: Number(process.env.MOSH_PRICE_OPUS_OUT_PER_M ?? "75"),
  },
};

const usage = { shimCalls: 0, openrouterCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

async function httpChat(
  base: string, key: string, model: string, messages: ChatMessage[], billed: boolean,
): Promise<{ content: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, max_tokens: 8192 }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`brain HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (billed) {
    const tIn = j.usage?.prompt_tokens ?? 0;
    const tOut = j.usage?.completion_tokens ?? 0;
    usage.tokensIn += tIn;
    usage.tokensOut += tOut;
    const price = PRICE_PER_M_TOKENS[model];
    if (price) usage.costUsd += (tIn / 1_000_000) * price.in + (tOut / 1_000_000) * price.out;
  }
  return { content: j.choices?.[0]?.message?.content ?? "", ms };
}

async function shimChat(messages: ChatMessage[]): Promise<{ content: string; ms: number }> {
  const base = process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8788/v1";
  const key = process.env.OPENAI_API_KEY ?? "shim";
  const model = MODEL === "opus" ? "opus" : "sonnet";
  usage.shimCalls += 1;
  return httpChat(base, key, model, messages, /* billed */ false);
}

async function openrouterChat(messages: ChatMessage[]): Promise<{ content: string; ms: number }> {
  const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const model = process.env.OPENROUTER_MODEL ?? (MODEL === "opus" ? "anthropic/claude-opus-5" : "anthropic/claude-sonnet-5");
  usage.openrouterCalls += 1;
  return httpChat(base, key, model, messages, /* billed */ true);
}

async function chatWithFallback(messages: ChatMessage[]): Promise<{ content: string; ms?: number }> {
  if (MOCK_BRAIN) return mockLoopChat(messages);
  const [primary, secondary] = BRAIN_PRIMARY === "openrouter" ? [openrouterChat, shimChat] : [shimChat, openrouterChat];
  try {
    return await primary(messages);
  } catch (e) {
    brainErrors.push(String((e as Error)?.message ?? e).slice(0, 200));
    try {
      return await secondary(messages);
    } catch (e2) {
      brainErrors.push(String((e2 as Error)?.message ?? e2).slice(0, 200));
      throw new Error(`both brain providers failed: ${brainErrors.join(" | ")}`);
    }
  }
}

// ── local task executor (companion HTTP in place of the store) ────────────
// Mirrors ui/src/agent/loop/taskExec.ts's createTaskExecutor contract — LAZY
// batch open, catalog validation, the task-cumulative destructive screen, ONE
// undo transaction for the whole task, render-job settle-wait — without the
// store dependency. Memory-command interception and the in-key note
// constraint are intentionally left out: produce-lane asks don't emit
// remember_preference, and the W2.5 preflight is the thing enforcing the
// octave/key rules here, not a per-note runtime clamp.

function newTurnId(): string {
  return `produce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type LocalTaskExecutor = {
  env: AgentEnv;
  /** Force the task's undo transaction open NOW (used before the W2.5
   *  preflight, which calls `exec` directly rather than through
   *  env.runBatch — the preflight's create_track/assign_sample/load_preset
   *  calls must land inside the SAME undo unit as the loop's note-writing
   *  steps, or a single Cmd+Z in the app would only undo part of the run). */
  forceOpen(): Promise<void>;
  close(): Promise<void>;
  opened(): boolean;
};

function makeLocalTaskExecutor(client: CompanionClient, label: string, meta: { utterance?: string; source?: string }): LocalTaskExecutor {
  let opened = false;
  let closed = false;
  let destructiveUsed = 0;

  async function getSnapshot(): Promise<Snapshot> {
    return client.snapshot();
  }

  async function ensureOpen(): Promise<void> {
    if (opened) return;
    const args: Record<string, unknown> = { name: label, turn_id: newTurnId(), source: meta.source ?? "agent_loop" };
    if (meta.utterance) args.utterance = meta.utterance;
    let begin = await client.command("batch_begin", args, { timeoutMs: TIMEOUT_MS });
    if (!begin.ok && /already open/i.test(begin.error ?? "")) {
      await client.command("batch_end", {}, { timeoutMs: TIMEOUT_MS }); // heal a zombie batch, retry once
      begin = await client.command("batch_begin", args, { timeoutMs: TIMEOUT_MS });
    }
    if (!begin.ok) throw new Error(`batch_begin failed: ${begin.error ?? "unknown error"}`);
    opened = true;
  }

  const env: AgentEnv = {
    getSnapshot,
    async runBatch(_label, calls) {
      if (closed) throw new Error("task executor is closed");
      type Entry = StepCommandResult & { index: number };
      const entries: Entry[] = [];
      const valid: Array<{ index: number; command: string; args: Record<string, unknown> }> = [];

      calls.forEach((c, index) => {
        const args = (c.args ?? {}) as Record<string, unknown>;
        const err = validateCommand(c.command, args);
        if (err) entries.push({ index, command: c.command, ok: false, error: err });
        else valid.push({ index, command: c.command, args });
      });

      const stepWeight = valid.reduce((n, c) => n + destructiveWeight(c.command), 0);
      let allowed = valid;
      if (destructiveUsed + stepWeight > MAX_DESTRUCTIVE_PER_BATCH) {
        for (const c of valid)
          if (isDestructiveCommand(c.command))
            entries.push({ index: c.index, command: c.command, ok: false, error: DESTRUCTIVE_BLOCK_REASON });
        allowed = valid.filter((c) => !isDestructiveCommand(c.command));
      } else {
        destructiveUsed += stepWeight;
      }

      if (allowed.length > 0) await ensureOpen();
      for (const c of allowed) {
        const r: CommandResult = await client.command(c.command, c.args, { timeoutMs: TIMEOUT_MS });
        entries.push({ index: c.index, command: c.command, ok: r.ok, error: r.ok ? undefined : r.error });
      }

      const started = allowed.filter((c) =>
        RENDER_JOB_COMMANDS.has(c.command)
        && entries.some((e) => e.index === c.index && e.ok)
        && typeof c.args.clipId === "string");
      if (started.length > 0)
        await awaitRendersSettled({ getSnapshot }, started.map((c) => c.args.clipId as string), {
          timeoutMs: 120_000,
          onAbort: async (clipId) => { await client.command("cancel_render", { clipId }, { timeoutMs: TIMEOUT_MS }); },
        });

      entries.sort((a, b) => a.index - b.index);
      return { results: entries.map(({ command, ok, error }) => ({ command, ok, error })), snapshot: await getSnapshot() };
    },
  };

  return {
    env,
    opened: () => opened,
    forceOpen: ensureOpen,
    async close() {
      if (closed) return;
      closed = true;
      if (opened) await client.command("batch_end", {}, { timeoutMs: TIMEOUT_MS });
    },
  };
}

// ── W2.5 preflight (dynamic import, try/catch-guarded — this driver must
//    still run, degraded, on a worktree where produceTemplate.ts isn't
//    landed yet; --no-preflight silences the resulting warning) ────────────

async function tryPreflight(rawExec: ProduceTemplateDeps["exec"], getSnapshot: () => Promise<Snapshot>, ask: string, seed: number): Promise<ProduceTemplate | undefined> {
  if (!resolvedConfig.preflight) return undefined;
  let mod: { runProduceTemplate?: (ask: string, deps: ProduceTemplateDeps) => Promise<ProduceTemplate> };
  try {
    mod = await import("../src/agent/loop/produceTemplate");
  } catch {
    console.error("[produceLiveRun] produceTemplate.ts not available yet — running WITHOUT the W2.5 preflight (the model lays its own template; expect a weaker first pass). Pass --no-preflight to silence this.");
    return undefined;
  }
  if (typeof mod.runProduceTemplate !== "function") {
    console.error("[produceLiveRun] produceTemplate.ts has no runProduceTemplate() export yet — skipping preflight.");
    return undefined;
  }
  // The native list_palette projection carries only {path, role, rootNote};
  // sub_energy_db (the 808 low-end pick, round-2 note 6) lives in the manifest
  // file, so the driver reads the manifest itself and injects the items.
  const manifestPath = argFlag("palette-manifest", resolve(process.env.HOME ?? "", "Library/Mosh/palette-v2/manifest.json"))!;
  let palette: PaletteItem[] | undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    palette = items
      .filter((it) => typeof it.path === "string" && existsSync(it.path as string))
      .map((it) => {
        const out: PaletteItem = { path: it.path as string, role: String(it.role ?? it.role_guess ?? "") };
        const root = typeof it.rootNote === "number" ? it.rootNote : typeof it.root_note === "number" ? it.root_note : undefined;
        const sub = typeof it.subEnergyDb === "number" ? it.subEnergyDb : typeof it.sub_energy_db === "number" ? it.sub_energy_db : undefined;
        if (root !== undefined) (out as { rootNote?: number }).rootNote = root;
        if (sub !== undefined) (out as { subEnergyDb?: number }).subEnergyDb = sub;
        return out;
      });
    console.error(`[produceLiveRun] palette from ${manifestPath}: ${palette.length} items`);
  } catch (e) {
    console.error(`[produceLiveRun] palette manifest unreadable (${String((e as Error)?.message ?? e).slice(0, 120)}) — falling back to list_palette`);
  }
  const template = await mod.runProduceTemplate(ask, { exec: rawExec, getSnapshot, seed, ...(palette ? { palette } : {}) });
  return template as ProduceTemplate;
}

// ── R2.4 repair hook (driver half) — checkProduceRun/renderCheckAsRepairError
// live in produceCheck.ts (another agent's file, not yet landed on every
// worktree): a dynamic, try/catch-guarded VALUE import, exactly tryPreflight's
// idiom above; the CheckInput/CheckReport TYPES are imported directly at the
// top of the file (erased at runtime — see that import's comment), so this
// driver keeps working whether or not produceCheck.ts exists yet. ──────────

type ProduceCheckModule = {
  checkProduceRun: (input: CheckInput) => CheckReport;
  renderCheckAsRepairError: (report: CheckReport) => string;
};

async function tryLoadProduceCheck(): Promise<ProduceCheckModule | undefined> {
  let mod: Partial<ProduceCheckModule>;
  try {
    mod = await import("../src/agent/loop/produceCheck");
  } catch {
    console.error("[produceLiveRun] produceCheck.ts not available yet — skipping the R2.4 repair hook (the run still saves/exports normally). Pass --no-repair to silence this.");
    return undefined;
  }
  if (typeof mod.checkProduceRun !== "function" || typeof mod.renderCheckAsRepairError !== "function") {
    console.error("[produceLiveRun] produceCheck.ts has no checkProduceRun()/renderCheckAsRepairError() exports yet — skipping the repair hook.");
    return undefined;
  }
  return mod as ProduceCheckModule;
}

/** Project the run's clips into produceCheck's CheckInput shape: which track
 *  is which role (drums/808/the 7 SynthRoles, straight from the W2.5
 *  template), and every note on it, in beats (matches add_midi_clip's own
 *  units — MoshOps.Clips.cpp:1779, commands.ts:71). Undefined when either the
 *  preflight never ran (no template — nothing to attribute roles to) or the
 *  loop never produced a final snapshot (nothing to check). */
function buildCheckInput(template: ProduceTemplate | undefined, snap: Snapshot | undefined): CheckInput | undefined {
  if (!template || !snap) return undefined;
  const roles: Record<string, string> = { [template.drums.trackId]: "drums", [template.bass.trackId]: "808" };
  for (const s of template.synths) roles[s.trackId] = s.role;
  const tracks: CheckInput["tracks"] = {};
  for (const trackId of Object.keys(roles)) {
    const t = snap.tracks?.find((x) => x.id === trackId);
    const notes = (t?.clips ?? []).flatMap((c) => c.notes ?? []);
    tracks[trackId] = notes.map((n) => ({ pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity }));
  }
  return { key: template.key, roles, tracks, pads: template.drums.pads.map((p) => p.note), bars: 8 };
}

// ── RSS sampling (optional, --pid) ─────────────────────────────────────────

function rssKb(pid: string | undefined): number | null {
  if (!pid) return null;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" });
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = makeCompanionClient({ url: URL, token: TOKEN!, defaultTimeoutMs: TIMEOUT_MS });

  console.error(`[produceLiveRun] health check ${URL} ...`);
  if (!(await client.health())) throw new Error(`companion server at ${URL} is not healthy (GET /health) — is the app up with MOSH_LAB_FEED=1?`);

  const rssBeforeKb = rssKb(APP_PID);
  const startedAt = Date.now();

  const newProj = await client.command("new_project", {}, { timeoutMs: 30_000 });
  if (!newProj.ok) throw new Error(`new_project failed: ${newProj.error}`);

  const progressEvents: LoopProgressEvent[] = [];
  const programLines: Array<{ command: string; args: unknown; ok?: boolean; error?: string }> = [
    { command: "new_project", args: {}, ok: true },
  ];

  const exec = makeLocalTaskExecutor(client, ASK!.slice(0, 48), { utterance: ASK, source: "agent_loop" });
  const signal = { aborted: false };
  const hardTimer = setTimeout(() => { signal.aborted = true; }, HARD_TIMEOUT_MS);

  let outcome = "error";
  let loopError: string | undefined;
  let finalSnap: Snapshot | undefined;
  let template: ProduceTemplate | undefined;
  let checkResult: {
    ok: boolean;
    initial: CheckReport | null;
    repaired: CheckReport | null;
    repairAttempted: boolean;
    repairOutcome?: string;
    skippedReason?: string;
  } | null = null;

  try {
    // The preflight's exec calls land inside the SAME undo unit as the loop's
    // steps — force the batch open before it runs (see forceOpen's comment).
    await exec.forceOpen();
    const rawExec = (command: string, args?: Record<string, unknown>) => client.command(command, args, { timeoutMs: TIMEOUT_MS });
    template = await tryPreflight(rawExec, () => client.snapshot(), ASK!, SEED);
    if (template) writeFileSync(resolve(OUT_DIR!, "template.json"), JSON.stringify(template, null, 2));

    // Same closure pattern producePrompt.ts's own header documents for
    // runTask.ts's wiring: bind `template` now so the loop FSM's own 3-arg
    // call (loop.ts:99) is exactly the "no preflight" shape, not a degraded one.
    const systemPrompt = template
      ? (snap: Snapshot | null, query?: string, memory?: string) => buildProduceSystemPrompt(snap, query, memory, template)
      : buildProduceSystemPrompt;

    // Every raw model reply lands in brain-replies.jsonl beside the run so a
    // parse/shape failure can be diagnosed from the file, not re-run.
    const repliesPath = resolve(OUT_DIR!, "brain-replies.jsonl");
    const loggedChat = async (messages: ChatMessage[]) => {
      const r = await chatWithFallback(messages);
      const lastUser = messages[messages.length - 1]?.content ?? "";
      appendFileSync(repliesPath, JSON.stringify({ ts: Date.now(), ms: r.ms ?? null, userTail: lastUser.slice(-400), content: r.content }) + "\n");
      return r;
    };
    const run = await runAgentLoop({ ask: ASK! }, {
      chat: loggedChat,
      env: exec.env,
      budgets: PRODUCE_BUDGETS,
      systemPrompt,
      signal,
      onProgress: (ev) => progressEvents.push(ev),
    });
    outcome = run.outcome;
    loopError = run.error;
    finalSnap = run.finalSnapshot;
    for (const step of run.transcript)
      step.commands.forEach((c, i) => programLines.push({ command: c.command, args: c.args, ok: step.results[i]?.ok, error: step.results[i]?.error }));

    // ── R2.4 repair hook — after the loop ends, BEFORE save/export, while the
    // batch is still open so a repair pass's commands land in the SAME undo
    // transaction as everything else in this run. ──────────────────────────
    const checkMod = await tryLoadProduceCheck();
    if (checkMod) {
      const input = buildCheckInput(template, finalSnap);
      if (!input) {
        checkResult = { ok: true, initial: null, repaired: null, repairAttempted: false, skippedReason: "no template/finalSnapshot to check (preflight skipped or the loop produced no snapshot)" };
      } else {
        const initial = checkMod.checkProduceRun(input);
        checkResult = { ok: initial.ok, initial, repaired: null, repairAttempted: false };
        if (!initial.ok && !NO_REPAIR) {
          checkResult.repairAttempted = true;
          const repairAsk = `${ASK!}\n\nREPAIR: ${checkMod.renderCheckAsRepairError(initial)}`;
          // The repair pass may only ADD material. Round-2 run 1's repair
          // "fixed" harmony clashes with remove_clip and left five tracks
          // empty, so any batch carrying a non-additive command is refused
          // whole (the loop replans on the error text).
          const REPAIR_ALLOWED = new Set(["add_midi_clip", "add_note", "set_note"]);
          const repairEnv: AgentEnv = {
            ...exec.env,
            runBatch: async (label, calls) => {
              const bad = calls.filter((c) => !REPAIR_ALLOWED.has(c.command)).map((c) => c.command);
              if (bad.length) {
                const results: StepCommandResult[] = calls.map((c) => ({
                  command: c.command, ok: false,
                  error: `repair pass may only add notes (add_midi_clip with inline notes); refused: ${[...new Set(bad)].join(", ")}`,
                }));
                return { results, snapshot: await exec.env.getSnapshot() };
              }
              return exec.env.runBatch(label, calls);
            },
          };
          const repairRun = await runAgentLoop({ ask: repairAsk }, {
            chat: loggedChat,
            env: repairEnv,
            budgets: { maxSteps: 6, maxPlannerCalls: 2, maxStepCalls: 6, softWallMs: 300_000 },
            systemPrompt,
            signal,
            onProgress: (ev) => progressEvents.push(ev),
          });
          checkResult.repairOutcome = repairRun.outcome;
          for (const step of repairRun.transcript)
            step.commands.forEach((c, i) => programLines.push({ command: c.command, args: c.args, ok: step.results[i]?.ok, error: step.results[i]?.error }));
          if (repairRun.finalSnapshot) finalSnap = repairRun.finalSnapshot;
          const reInput = buildCheckInput(template, finalSnap);
          if (reInput) {
            const repaired = checkMod.checkProduceRun(reInput);
            checkResult.repaired = repaired;
            checkResult.ok = repaired.ok;
          }
        }
      }
    }
  } catch (e) {
    loopError = String((e as Error)?.message ?? e).slice(0, 500);
  } finally {
    clearTimeout(hardTimer);
    await exec.close();
  }

  // Settle, then persist: .mosh save + loop-length wav export. Both run even
  // on an error/budget/need_user outcome — a partial arrangement is still
  // worth auditioning, and run.json records the honest outcome either way.
  await sleep(2_000);
  const moshFile = resolve(OUT_DIR!, `produce-${RUN_ID}-${MODEL}.mosh`);
  const wavFile = resolve(OUT_DIR!, "mix.wav");
  const saveRes = await client.command("save_as", { file: moshFile }, { timeoutMs: 60_000 });
  // No loop region is set by the preflight, so render an explicit 8-bar window
  // (32 beats at the session tempo) rather than range:"loop".
  const bpm = Number(finalSnap?.session?.tempo ?? template?.bpm ?? 148) || 148;
  const eightBarsSeconds = Number(template?.constants?.eightBarsSeconds) || (32 * 60) / bpm;
  const exportRes = await client.command(
    "export_audio",
    { file: wavFile, format: "wav", range: "custom", start: 0, end: eightBarsSeconds, renderMode: "auto", tail: "include", tailSeconds: 1 },
    { timeoutMs: 180_000 },
  );

  let renderBytes = 0;
  let renderRmsDbfs: number | null = null;
  let silentRender = true;
  if (existsSync(wavFile)) {
    renderBytes = statSync(wavFile).size;
    try {
      renderRmsDbfs = wavRmsDbfs(wavFile);
      silentRender = renderRmsDbfs < -60;
    } catch (e) {
      console.error(`[produceLiveRun] wavRmsDbfs failed: ${String((e as Error)?.message ?? e)}`);
    }
  }

  // ── R2.8 — stems, so the next correction round can name WHICH track is
  // wrong instead of just "the mix". A generous timeout: rendering 9 tracks
  // one-by-one runs well past a single export_audio's budget. Best-effort —
  // a stems failure never fails the run; run.json.stemsError records why.
  const stemsDir = resolve(OUT_DIR!, "stems");
  mkdirSync(stemsDir, { recursive: true });
  const stemsRes = await client.command("export_stems", { dir: stemsDir, format: "wav" }, { timeoutMs: 300_000 });
  const stems = stemsRes.ok
    ? ((stemsRes.data as { stems?: Array<{ trackId: string; name: string; index: number; file: string; bytes: number }> } | undefined)?.stems ?? [])
    : [];
  if (!stemsRes.ok) console.error(`[produceLiveRun] export_stems failed: ${stemsRes.error ?? "unknown error"}`);

  const rssAfterKb = rssKb(APP_PID);
  const endedAt = Date.now();
  const clipCount = (snap: Snapshot | undefined) => (snap?.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);

  const runJson = {
    v: 1,
    runId: RUN_ID,
    ask: ASK,
    model: MODEL,
    provider: MOCK_BRAIN ? "mock" : BRAIN_PRIMARY,
    seed: SEED,
    outcome,
    error: loopError,
    brainErrors,
    startedAt,
    endedAt,
    wallMs: endedAt - startedAt,
    steps: programLines.length - 1, // exclude the synthetic new_project line
    commandsOk: programLines.filter((l) => l.ok === true).length,
    commandsInvalid: programLines.filter((l) => l.ok === false).length,
    tracks: finalSnap?.tracks?.length ?? null,
    clips: finalSnap ? clipCount(finalSnap) : null,
    tempo: finalSnap?.session?.tempo ?? null,
    key: finalSnap?.session?.key ?? null,
    save: { ok: saveRes.ok, error: saveRes.error, file: moshFile },
    render: { file: wavFile, ok: exportRes.ok, error: exportRes.error, bytes: renderBytes, seconds: null, rmsDbfs: renderRmsDbfs, silentRender },
    stems,
    stemsOk: stemsRes.ok,
    stemsError: stemsRes.ok ? undefined : stemsRes.error,
    check: checkResult,
    appRssBeforeKb: rssBeforeKb,
    appRssAfterKb: rssAfterKb,
    preflight: !!template,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: Number(usage.costUsd.toFixed(4)),
    brainCalls: { shim: usage.shimCalls, openrouter: usage.openrouterCalls },
  };
  writeFileSync(resolve(OUT_DIR!, "run.json"), JSON.stringify(runJson, null, 2));
  writeFileSync(resolve(OUT_DIR!, "transcript.json"), JSON.stringify(progressEvents, null, 2));
  writeFileSync(resolve(OUT_DIR!, "program.jsonl"), programLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  console.log(JSON.stringify({ ok: outcome === "done", runId: RUN_ID, outcome, render: runJson.render }, null, 2));
  process.exitCode = outcome === "done" || outcome === "budget" ? 0 : 1;
}

main().catch((e) => {
  console.error("[produceLiveRun] FATAL", e);
  process.exitCode = 1;
});
