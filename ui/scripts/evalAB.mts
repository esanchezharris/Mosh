// Efficacy A/B: does injecting retrieved RECIPE cards make the agent plan BETTER commands —
// and does CONCRETE worked-example rendering + top-1 retrieval finally lift it where intent-
// only injection did not? For each case we generate the agent's reply under each ARM —
//   none     = systemPrompt(snap, plugins, [])                       (no cards, the baseline)
//   intent   = retrieveCards@k → systemPrompt(..., {recipeRender:"intent"})   (the legacy form)
//   concrete = retrieveCards@k → systemPrompt(..., {recipeRender:"concrete"}) (the worked example)
// across k ∈ EVAL_AB_KS, score with the shared evalSuite rubric, repeat N times, and report a
// per-case + aggregate matrix plus the PRE-REGISTERED verdict bucket (evalABVerdict). The
// "Production moves" teaching is in EVERY arm (it's not a card), so this isolates the MARGINAL
// value of the cards. Symbolic plan-quality only — does the agent reach for the right commands.
//
//   # cheap smoke (none vs concrete @ k3, 3 reps):
//   EVAL_AB_PROVIDER=openai npm run eval-ab
//   # the pre-registered decision sweep (3 arms × k{1,3}, 8 reps):
//   EVAL_AB_PROVIDER=openai EVAL_AB_REPS=8 EVAL_AB_ARMS=none,intent,concrete EVAL_AB_KS=1,3 npm run eval-ab
//
// Keys come from ui/.env.local (loaded below) — read by reference, never logged.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../src/types";
import { loadEnvFiles, resolveProvider, callLLM, type Provider } from "./llm.mts";
import { EVAL_CASES, EVAL_SNAPSHOT, EVAL_PLUGINS, scoreReply, type EvalCase } from "../src/agent/evalSuite";
import { systemPrompt, type RecipeRender } from "../src/agent/prompt";
import { retrieveCards } from "../src/agent/knowledge/retrieve";
import { verdictBucket, goldenOk } from "../src/agent/evalABVerdict";

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

// Card-TARGETED asks: each retrieves a matching recipe card, so the lifted arms get the
// technique and the check verifies the agent reached for it. This is where a card SHOULD
// lift — vs the golden cases (mostly card-irrelevant → a no-regression check).
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

type ArmName = "none" | "intent" | "concrete";
const ARM_SPEC: Record<ArmName, { withCards: boolean; render: RecipeRender }> = {
  none: { withCards: false, render: "concrete" },
  intent: { withCards: true, render: "intent" },
  concrete: { withCards: true, render: "concrete" },
};

const reps = Number(process.env.EVAL_AB_REPS || 3);
const ARMS = (process.env.EVAL_AB_ARMS || "none,concrete").split(",").map((s) => s.trim()).filter(Boolean) as ArmName[];
const KS = (process.env.EVAL_AB_KS || String(process.env.EVAL_AB_K || 3)).split(",").map(Number).filter((k) => k > 0);
const productK = Math.min(...KS); // the SHIPPED retrieval depth (top-1) — golden is gated here

type Cell = { arm: ArmName; k: number; key: string; label: string };
const noneCell: Cell = { arm: "none", k: productK, key: "none", label: "none" };
const cardCells: Cell[] = [];
for (const k of KS) for (const arm of ARMS.filter((a) => a !== "none")) cardCells.push({ arm, k, key: `${arm}@k${k}`, label: `${arm}@k${k}` });
const targetedCells: Cell[] = [...(ARMS.includes("none") ? [noneCell] : []), ...cardCells];
// Golden no-regression only needs the SHIPPED arms (baseline + the product's concrete@top-1).
const goldenCells: Cell[] = [
  ...(ARMS.includes("none") ? [noneCell] : []),
  ...(ARMS.includes("concrete") ? [{ arm: "concrete" as ArmName, k: productK, key: `concrete@k${productK}`, label: `concrete@k${productK}` }] : []),
];

type CaseResult = { id: string; targeted: boolean; injected: number; passes: Record<string, number> };

async function cellPasses(provider: Provider, c: EvalCase, cell: Cell): Promise<{ passes: number; injected: number }> {
  const spec = ARM_SPEC[cell.arm];
  let passes = 0, injected = 0;
  for (let r = 0; r < reps; r++) {
    const cards = spec.withCards ? retrieveCards(c.ask, cell.k) : [];
    injected = cards.length;
    const sys = systemPrompt(c.snap ?? EVAL_SNAPSHOT, EVAL_PLUGINS, cards, { recipeRender: spec.render });
    const reply = await callLLM(provider, [{ role: "system", content: sys }, { role: "user", content: c.ask }], { maxTokens: 1000 });
    if (scoreReply(c, reply).pass) passes++;
  }
  return { passes, injected };
}

async function runCases(provider: Provider, cases: EvalCase[], cells: Cell[], targeted: boolean): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of cases) {
    const passes: Record<string, number> = {};
    let injected = 0;
    for (const cell of cells) {
      const r = await cellPasses(provider, c, cell);
      passes[cell.key] = r.passes;
      if (cell.arm !== "none") injected = Math.max(injected, r.injected);
    }
    out.push({ id: c.id, targeted, injected, passes });
    const cells4 = cells.map((cell) => `${cell.label} ${passes[cell.key]}/${reps}`).join("  ");
    console.error(`  ${targeted ? "◆" : " "} ${c.id.padEnd(16)} ${cells4}`);
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const rate = (results: CaseResult[], key: string) => {
  const denom = results.length * reps;
  return denom ? results.reduce((a, r) => a + (r.passes[key] ?? 0), 0) / denom : 0;
};
const hasCell = (arm: ArmName, k: number) => targetedCells.some((c) => c.arm === arm && c.k === k);

async function main() {
  loadEnvFiles(UI_ROOT);
  const provider = resolveProvider(process.env.EVAL_AB_PROVIDER);
  if (!provider) { console.error("no LLM provider — set keys in ui/.env.local"); process.exit(2); }
  mkdirSync(OUT_DIR, { recursive: true });

  const golden = process.env.EVAL_AB_TARGETED ? [] : process.env.EVAL_AB_FULL ? EVAL_CASES : EVAL_CASES.filter((c) => NOREG_IDS.has(c.id));
  console.error(
    `\nEfficacy A/B · provider=${provider.id}/${provider.model} · arms=[${ARMS.join(",")}] · k=[${KS.join(",")}] · ` +
    `${RECIPE_CASES.length} targeted + ${golden.length} golden × ${reps} reps\n`,
  );

  const targetedResults = await runCases(provider, RECIPE_CASES, targetedCells, true);
  const goldenResults = golden.length ? await runCases(provider, golden, goldenCells, false) : [];

  const md = report(provider, targetedResults, goldenResults);
  writeFileSync(resolve(OUT_DIR, "report.md"), md);
  for (const line of verdictLines(targetedResults, goldenResults)) console.error(line);
  console.error(`Full report: ${resolve(OUT_DIR, "report.md")}`);
}

// Golden no-regression: did the shipped concrete@top-1 arm avoid a card-induced drop vs the
// no-cards baseline? ok === null means NO coverage (a golden arm wasn't run) — NOT a pass.
function goldenVerdict(goldenResults: CaseResult[]): { ok: boolean | null; none: number | null; concrete: number | null } {
  const none = ARMS.includes("none") && goldenResults.length ? rate(goldenResults, "none") : null;
  const concrete = ARMS.includes("concrete") && goldenResults.length ? rate(goldenResults, `concrete@k${productK}`) : null;
  return { ok: goldenOk(none, concrete), none, concrete };
}

function verdictLines(targetedResults: CaseResult[], goldenResults: CaseResult[]): string[] {
  const L: string[] = [];
  L.push("\nTargeted asks — pass-rate per arm:");
  for (const cell of targetedCells) L.push(`  ${cell.label.padEnd(14)} ${pct(rate(targetedResults, cell.key))}`);
  const g = goldenVerdict(goldenResults);
  const goldenTxt = g.ok == null ? "(no coverage — run golden arms)" : g.ok ? "✓" : "✗ REGRESSED";
  L.push(`Golden no-regression: none ${g.none == null ? "—" : pct(g.none)} → concrete@k${productK} ${g.concrete == null ? "—" : pct(g.concrete)} ${goldenTxt}`);

  const fullArms = hasCell("concrete", 1) && hasCell("intent", 3) && ARMS.includes("none");
  if (fullArms && g.ok != null) {
    const concreteK1 = rate(targetedResults, "concrete@k1");
    const intentK3 = rate(targetedResults, "intent@k3");
    const baseline = rate(targetedResults, "none");
    const bucket = verdictBucket({ concreteK1, intentK3, baseline, goldenOk: g.ok });
    L.push(`VERDICT: ${bucket}  ·  concrete@k1 ${pct(concreteK1)} vs baseline ${pct(baseline)} vs intent@k3 ${pct(intentK3)} (control)`);
  } else if (fullArms) {
    // Full targeted arms but no golden coverage → not a shippable verdict.
    const concreteK1 = rate(targetedResults, "concrete@k1");
    const baseline = rate(targetedResults, "none");
    L.push(`VERDICT: targeted-only (NO golden regression data) · concrete@k1 ${pct(concreteK1)} vs baseline ${pct(baseline)} — add golden for a shippable bucket`);
  } else {
    L.push("VERDICT: run the decision sweep for the pre-registered bucket — EVAL_AB_ARMS=none,intent,concrete EVAL_AB_KS=1,3 EVAL_AB_REPS=8");
  }
  return L;
}

function report(provider: Provider, targetedResults: CaseResult[], goldenResults: CaseResult[]): string {
  const L: string[] = [];
  L.push(`# Efficacy A/B — does concrete-recipe rendering + top-1 retrieval lift the agent's plan?\n`);
  L.push(
    `provider \`${provider.id}/${provider.model}\` · ${reps} reps/cell · arms [${ARMS.join(", ")}] × k [${KS.join(", ")}]. ` +
    `none = no cards; intent = legacy producer_intent injection; concrete = worked-example rendering. ` +
    `The "Production moves" teaching is in EVERY arm, so this is the MARGINAL value of the cards.\n`,
  );
  for (const line of verdictLines(targetedResults, goldenResults)) L.push(line);

  // Per-case targeted table (one column per cell + Δ of the decision arm vs baseline).
  const decisionKey = hasCell("concrete", productK) ? `concrete@k${productK}` : null;
  L.push(`\n## Targeted asks (◆ = a matching recipe card exists)\n`);
  L.push(`| case | ${targetedCells.map((c) => c.label).join(" | ")}${decisionKey && ARMS.includes("none") ? " | Δ(concrete−none) |" : " |"}`);
  L.push(`|------|${targetedCells.map(() => ":--:").join("|")}|${decisionKey && ARMS.includes("none") ? ":--:|" : ""}`);
  for (const r of targetedResults) {
    const cols = targetedCells.map((c) => `${r.passes[c.key] ?? 0}/${reps}`).join(" | ");
    const delta = decisionKey && ARMS.includes("none") ? ` | ${(r.passes[decisionKey] ?? 0) - (r.passes["none"] ?? 0)} |` : " |";
    L.push(`| ${r.id} | ${cols}${delta}`);
  }

  if (goldenResults.length) {
    L.push(`\n## Golden no-regression (cards must not break these)\n`);
    L.push(`| case | ${goldenCells.map((c) => c.label).join(" | ")} |`);
    L.push(`|------|${goldenCells.map(() => ":--:").join("|")}|`);
    for (const r of goldenResults) L.push(`| ${r.id} | ${goldenCells.map((c) => `${r.passes[c.key] ?? 0}/${reps}`).join(" | ")} |`);
  }

  L.push(`\n_Pre-registered bar: LIFT = concrete@k1 − baseline ≥ +10pp AND ≥ intent@k3; a golden drop FAILs the run. Symbolic plan-quality only (did the agent reach for the right commands), not audio quality._\n`);
  return L.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
