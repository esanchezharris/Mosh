// Efficacy A/B: does injecting retrieved RECIPE cards make the agent plan BETTER commands?
// For each case we generate the agent's reply TWICE under an otherwise-identical prompt —
// baseline `systemPrompt(snap, plugins, [])` vs lifted `systemPrompt(snap, plugins,
// retrieveCards(ask))` — score both with the shared evalSuite rubric, repeat N times, and
// report the pass-rate delta. The "Production moves" teaching is in BOTH arms (it's not a
// card), so this isolates the MARGINAL lift of the retrieved cards. Symbolic plan-quality
// only — does the agent reach for the right commands — NOT audio quality (deferred).
//
//   EVAL_AB_PROVIDER=openai EVAL_AB_REPS=3 npm run eval-ab
//   EVAL_AB_FULL=1 npm run eval-ab        # also run the whole golden suite (no-regression)
//
// Keys come from ui/.env.local (loaded below) — read by reference, never logged.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../src/types";
import { loadEnvFiles, resolveProvider, callLLM, type Provider } from "./llm.mts";
import { EVAL_CASES, EVAL_SNAPSHOT, EVAL_PLUGINS, scoreReply, type EvalCase } from "../src/agent/evalSuite";
import { systemPrompt } from "../src/agent/prompt";
import { retrieveCards } from "../src/agent/knowledge/retrieve";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/efficacy");

const n = (v: unknown) => (typeof v === "number" ? v : NaN);
const find = (cs: { command: string; args?: Record<string, unknown> }[], name: string) => cs.find((c) => c.command === name);

// A session with MIDI clips + an EQ so a recipe-card move (lay a grid, swing, send,
// automate) has somewhere to land — distinct from the minimal golden EVAL_SNAPSHOT.
const AB_SNAPSHOT = {
  session: { tempo: 90, timeSigNumerator: 4, timeSigDenominator: 4, key: { tonic: "A", mode: "minor" } },
  tracks: [
    { id: "t-drums", name: "Drums", volumeDb: 0, clips: [{ id: "c-drum", type: "midi", start: 0, notes: [] }] },
    { id: "t-hats", name: "Hats", volumeDb: 0, clips: [{ id: "c-hats", type: "midi", start: 0, notes: [{ i: 0, pitch: 42, start: 0, length: 0.25, velocity: 90 }] }] },
    { id: "t-keys", name: "Keys", volumeDb: -6, clips: [{ id: "c-keys", type: "midi", start: 0, notes: [{ i: 0, pitch: 60, start: 0, length: 1, velocity: 80 }] }],
      plugins: [{ index: 0, name: "Pro-Q 3", params: [{ index: 0, name: "Frequency", value: 0.3 }] }] },
  ],
} as unknown as Snapshot;

// Card-TARGETED asks: each retrieves a matching recipe card, so the lifted arm gets the
// technique's recipe and the check verifies the agent reached for it. This is where a
// card SHOULD lift — vs the golden cases (mostly card-irrelevant → a no-regression check).
const RECIPE_CASES: EvalCase[] = [
  { id: "ab-boombap", ask: "program a classic boom-bap drum pattern on the drums — kick, snare, hats", snap: AB_SNAPSHOT,
    want: "lays a drum grid (≥3 add_note with kick/snare/hat pitches)",
    check: (r) => r.commands.filter((c) => c.command === "add_note" && [36, 38, 42, 39].includes(n(c.args?.pitch))).length >= 3 },
  { id: "ab-swing", ask: "the hi-hats feel too stiff and robotic — give them a swung boom-bap MPC groove", snap: AB_SNAPSHOT,
    want: "quantize_notes with swing, or humanize_notes",
    check: (r) => { const q = find(r.commands, "quantize_notes"); return (!!q && n(q.args?.swing) > 0) || !!find(r.commands, "humanize_notes"); } },
  { id: "ab-send", ask: "give the keys some depth with a shared reverb on a send bus", snap: AB_SNAPSHOT,
    want: "create_bus and/or add_send",
    check: (r) => !!find(r.commands, "add_send") || !!find(r.commands, "create_bus") },
  { id: "ab-trap", ask: "lay down a trap drum pattern with a booming 808 and a hard snare", snap: AB_SNAPSHOT,
    want: "lays a drum grid (≥3 add_note)",
    check: (r) => r.commands.filter((c) => c.command === "add_note").length >= 3 },
  { id: "ab-filter-sweep", ask: "open the keys filter up over the intro for movement", snap: AB_SNAPSHOT,
    want: "automation on the keys EQ",
    check: (r) => { const c = find(r.commands, "add_automation_point") ?? find(r.commands, "set_automation_point"); return c?.args?.trackId === "t-keys"; } },
];

// A representative golden subset for the no-regression check (cards must not break these).
const NOREG_IDS = new Set(["create-track", "mute-named", "play", "no-fake-id", "multi-step", "bounce-track", "automate-sweep", "param-by-name", "humanize-feel"]);

type Row = { id: string; ask: string; targeted: boolean; injected: number; basePass: number; liftPass: number; reps: number };

const RETRIEVE_K = Number(process.env.EVAL_AB_K || 3);

async function arm(provider: Provider, c: EvalCase, withCards: boolean): Promise<{ pass: boolean; injected: number }> {
  const cards = withCards ? retrieveCards(c.ask, RETRIEVE_K) : [];
  const sys = systemPrompt(c.snap ?? EVAL_SNAPSHOT, EVAL_PLUGINS, cards);
  const reply = await callLLM(provider, [{ role: "system", content: sys }, { role: "user", content: c.ask }], { maxTokens: 1000 });
  return { pass: scoreReply(c, reply).pass, injected: cards.length };
}

async function main() {
  loadEnvFiles(UI_ROOT);
  const provider = resolveProvider(process.env.EVAL_AB_PROVIDER);
  if (!provider) { console.error("no LLM provider — set keys in ui/.env.local"); process.exit(2); }
  mkdirSync(OUT_DIR, { recursive: true });

  const reps = Number(process.env.EVAL_AB_REPS || 3);
  const golden = process.env.EVAL_AB_TARGETED ? [] : process.env.EVAL_AB_FULL ? EVAL_CASES : EVAL_CASES.filter((c) => NOREG_IDS.has(c.id));
  const cases: { c: EvalCase; targeted: boolean }[] = [
    ...RECIPE_CASES.map((c) => ({ c, targeted: true })),
    ...golden.map((c) => ({ c, targeted: false })),
  ];
  console.error(`\nEfficacy A/B · provider=${provider.id}/${provider.model} · top-${RETRIEVE_K} retrieval · ${cases.length} cases × ${reps} reps × {baseline, lifted}\n`);

  const rows: Row[] = [];
  for (const { c, targeted } of cases) {
    let basePass = 0, liftPass = 0, injected = 0;
    for (let r = 0; r < reps; r++) {
      const b = await arm(provider, c, false);
      const l = await arm(provider, c, true);
      basePass += b.pass ? 1 : 0;
      liftPass += l.pass ? 1 : 0;
      injected = l.injected;
    }
    const row: Row = { id: c.id, ask: c.ask, targeted, injected, basePass, liftPass, reps };
    rows.push(row);
    const d = liftPass - basePass;
    console.error(`  ${(targeted ? "◆" : " ")} ${c.id.padEnd(16)} base ${basePass}/${reps}  lift ${liftPass}/${reps}  ${d > 0 ? "▲+" + d : d < 0 ? "▼" + d : "="}  (cards:${injected})`);
  }

  const md = report(provider, reps, rows);
  writeFileSync(resolve(OUT_DIR, "report.md"), md);
  console.error(`\n${verdictLine(rows, reps)}`);
  console.error(`Full report: ${resolve(OUT_DIR, "report.md")}`);
}

function rate(rows: Row[], pick: (r: Row) => number): number {
  const reps = rows.reduce((a, r) => a + r.reps, 0);
  return reps ? rows.reduce((a, r) => a + pick(r), 0) / reps : 0;
}

function verdictLine(rows: Row[], _reps: number): string {
  const targeted = rows.filter((r) => r.targeted);
  const inj = rows.filter((r) => r.injected > 0);
  const noreg = rows.filter((r) => !r.targeted);
  const tB = rate(targeted, (r) => r.basePass), tL = rate(targeted, (r) => r.liftPass);
  const nB = rate(noreg, (r) => r.basePass), nL = rate(noreg, (r) => r.liftPass);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `VERDICT · card-targeted asks: baseline ${pct(tB)} → lifted ${pct(tL)} (Δ ${pct(tL - tB)}, ${inj.length} retrieved a card) · golden no-regression: ${pct(nB)} → ${pct(nL)}`;
}

function report(provider: Provider, reps: number, rows: Row[]): string {
  const L: string[] = [];
  L.push(`# Efficacy A/B — does injecting retrieved recipe cards lift the agent's plan?\n`);
  L.push(`provider \`${provider.id}/${provider.model}\` · ${reps} reps/arm · baseline = no cards, lifted = retrieveCards(ask). The "Production moves" teaching is in BOTH arms, so this is the MARGINAL lift of the cards.\n`);
  L.push(`◆ = card-targeted ask (a matching recipe card exists). Plain = golden no-regression.\n`);
  L.push(verdictLine(rows, reps) + "\n");
  L.push(`| case | targeted | cards | baseline | lifted | Δ |`);
  L.push(`|------|:--:|:--:|:--:|:--:|:--:|`);
  for (const r of rows) {
    const d = r.liftPass - r.basePass;
    L.push(`| ${r.id} | ${r.targeted ? "◆" : ""} | ${r.injected} | ${r.basePass}/${r.reps} | ${r.liftPass}/${r.reps} | ${d > 0 ? "+" + d : d} |`);
  }
  L.push(`\n_Symbolic plan-quality (did the agent reach for the right commands), not audio quality — that's the deferred layer._\n`);
  return L.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
