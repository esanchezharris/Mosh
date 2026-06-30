// ── Score real beat-build output with the deterministic recipe verifier ───────
// Drives buildBeat (no-model floor / local / cloud), reads the built mock state, extracts
// the recipe (recipeFromSnapshot), and grades its musical DNA with verifyRecipe — NO audio,
// NO render. Shows the deterministic recipe reward on the ACTUAL agent output, and whether
// it separates model beats from the deterministic fallback and from a control.
//
//   AUDITION_CLOUD=1 npm run tsx scripts/verifyBeats.mts -- --n 3       (cloud)
//   npm run tsx scripts/verifyBeats.mts -- --no-model                   (fallback floor)

import { __resetMockForTests, mockExecute, mockSnapshot } from "../src/bridge.mock";
import { buildBeat, type BeatSink, type BrainFn, type AgentCommandCall } from "../src/agent/beatBuilder";
import { BEAT_SPECS } from "../src/agent/beatSpecs";
import { verifyRecipe, recipeFromSnapshot } from "../src/agent/recipeVerifier";
import type { CommandResult, Snapshot } from "../src/types";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k: string) => process.argv.includes(`--${k}`);
const CLOUD = has("cloud") || process.env.AUDITION_CLOUD === "1";
const NO_MODEL = has("no-model");
const N = parseInt(arg("n", "1"), 10) || 1;
const PORT = process.env.AUDITION_PORT ?? "8081";
const GKEY = process.env.GEMINI_API_KEY ?? "";
const CLOUD_MODEL = process.env.MOSH_AGENT_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = CLOUD ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : `http://127.0.0.1:${PORT}/v1/chat/completions`;

const brain: BrainFn = async (messages, opts) => {
  if (NO_MODEL) throw new Error("no-model");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body: Record<string, unknown> = { messages, max_tokens: 2048, temperature: 1.0 };
  if (CLOUD) { headers["Authorization"] = `Bearer ${GKEY}`; body.model = CLOUD_MODEL; body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } }; if (opts.json) body.response_format = { type: "json_object" }; }
  const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
};

// minimal sink — we only need the mock state afterwards, not run-script lines
class MockSink implements BeatSink {
  async execute(call: AgentCommandCall) {
    let res: any = null;
    try { res = await mockExecute<CommandResult>({ command: call.command, args: call.args ?? {} }); } catch { res = { ok: false }; }
    const id = res?.ok ? (res?.trackId ?? res?.clipId ?? res?.data?.trackId ?? res?.data?.clipId ?? res?.id) : undefined;
    return { ok: !!res?.ok, id: id != null ? String(id) : undefined, error: res?.error };
  }
}

async function main() {
  console.log(`verify-beats: mode=${NO_MODEL ? "NO-MODEL floor" : CLOUD ? `cloud ${CLOUD_MODEL}` : `local:${PORT}`} n=${N}\n`);
  const rows: { id: string; total: number; dims: any; modelSlots: number; reasons: string[] }[] = [];
  for (let rep = 0; rep < N; rep++) {
    for (const spec of BEAT_SPECS) {
      __resetMockForTests();
      await mockExecute<CommandResult>({ command: "new_project", args: {} });
      const b = await buildBeat(spec, brain, new MockSink(), { maxRetries: 2, refineTempo: true });
      const snap = await mockSnapshot<Snapshot>();
      const recipe = recipeFromSnapshot(snap as any, spec.bars);
      const v = verifyRecipe(recipe);
      const id = N > 1 ? `${spec.id}-r${rep + 1}` : spec.id;
      const d = v.dims;
      console.log(`${id.padEnd(14)} total ${v.total.toFixed(3)}  | parts ${d.parts.toFixed(2)} drums ${d.drums.toFixed(2)} grid ${d.grid.toFixed(2)} key ${d.key.toFixed(2)} reg ${d.register.toFixed(2)} dens ${d.density.toFixed(2)} hyg ${d.hygiene.toFixed(2)}  | model ${b.modelSlots}/${b.totalSlots}`);
      if (v.reasons.length) console.log(`               reasons: ${v.reasons.slice(0, 4).join("; ")}`);
      rows.push({ id, total: v.total, dims: d, modelSlots: b.modelSlots, reasons: v.reasons });
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  console.log(`\nmean recipe-verifier score: ${mean(rows.map((r) => r.total)).toFixed(4)}  (n=${rows.length})`);
}

main();
