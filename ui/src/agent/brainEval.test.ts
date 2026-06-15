// Live intent→command eval: does the real brain (a real LLM, with the real system
// prompt + catalog) turn natural language into the RIGHT valid commands? This is the
// one piece the offline tests can't cover — it needs a provider.
//
// SKIPPED BY DEFAULT (no network, no cost). To run:
//   MOSH_BRAIN_EVAL=1 DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=https://api.deepseek.com \
//   DEEPSEEK_MODEL=deepseek-chat  npm run brain-eval
// (openai / xai env vars work too — same names the C++ BrainProxy resolves.)
import { describe, it, expect } from "vitest";
import { systemPrompt } from "./prompt";
import { parseReply } from "./parseReply";
import { validateCommand } from "./commands";
import type { Snapshot } from "../types";

type Provider = { id: string; baseUrl: string; key: string; model: string };

/** Resolve a provider from env, mirroring src/brain/BrainProxy.cpp's resolution order. */
function resolveProvider(): Provider | null {
  const env = (k: string) => process.env[k] ?? "";
  const cands: Provider[] = [
    { id: "deepseek", baseUrl: env("DEEPSEEK_BASE_URL"), key: env("DEEPSEEK_API_KEY"), model: env("DEEPSEEK_MODEL") },
    { id: "openai", baseUrl: env("OPENAI_BASE_URL"), key: env("OPENAI_API_KEY"), model: env("OPENAI_MODEL") },
    { id: "xai", baseUrl: env("XAI_BASE_URL"), key: env("XAI_API_KEY"), model: env("XAI_MODEL") },
  ];
  const want = process.env.MOSHI_BRAIN_PROVIDER;
  const complete = (p: Provider) => p.baseUrl && p.key && p.model;
  return (want && cands.find((p) => p.id === want && complete(p))) || cands.find(complete) || null;
}

const provider = resolveProvider();
const RUN = process.env.MOSH_BRAIN_EVAL === "1" && provider !== null;
if (!RUN) {
  // eslint-disable-next-line no-console
  console.warn("[brain-eval] skipped — set MOSH_BRAIN_EVAL=1 and a <PROVIDER>_API_KEY/_BASE_URL/_MODEL to run the live eval.");
}

const isReasoning = (m: string) => /^(gpt-5|gpt-6|o[0-9])/.test(m);

async function callLLM(p: Provider, sys: string, user: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_object" },
  };
  if (p.id === "openai" && isReasoning(p.model)) body.max_completion_tokens = 800;
  else { body.max_tokens = 800; body.temperature = 0.4; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

const SNAP = {
  session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4 },
  tracks: [
    { id: "t-drums", name: "Drums", volumeDb: 0, mute: false, solo: false, clips: [] },
    { id: "t-bass", name: "Bass", volumeDb: 0, mute: false, solo: false, clips: [] },
  ],
} as unknown as Snapshot;

type Args = Record<string, unknown>;
type Case = { ask: string; cmd: string; argCheck?: (a: Args) => boolean };

const CASES: Case[] = [
  { ask: "add a new audio track and call it Keys", cmd: "create_track", argCheck: (a) => typeof a.name === "string" && /key/i.test(a.name as string) },
  { ask: "set the tempo to 90 bpm", cmd: "set_tempo", argCheck: (a) => a.bpm === 90 },
  { ask: "mute the bass", cmd: "set_track_mute", argCheck: (a) => a.trackId === "t-bass" && a.mute === true },
  { ask: "turn the drums down a little", cmd: "set_track_volume", argCheck: (a) => a.trackId === "t-drums" },
  { ask: "start playing", cmd: "set_transport", argCheck: (a) => a.action === "toggle" || a.action === "play" },
];

describe.skipIf(!RUN)(`brain eval (live LLM · ${provider?.id ?? "none"})`, () => {
  const sys = systemPrompt(SNAP);

  for (const c of CASES) {
    it(`"${c.ask}" → ${c.cmd}`, async () => {
      const reply = parseReply(await callLLM(provider!, sys, c.ask));
      const cmds = reply.commands ?? [];

      // Nothing the brain emits may be a hallucinated / malformed command.
      for (const cc of cmds) expect(validateCommand(cc.command, cc.args ?? {})).toBeNull();

      // The expected command must be present...
      const hit = cmds.find((cc) => cc.command === c.cmd);
      expect(hit, `expected ${c.cmd}, got [${cmds.map((x) => x.command).join(", ")}] (say: ${reply.say ?? ""})`).toBeTruthy();

      // ...with sane args.
      if (hit && c.argCheck) expect(c.argCheck(hit.args ?? {}), `bad args: ${JSON.stringify(hit.args)}`).toBe(true);
    }, 35_000);
  }
});
