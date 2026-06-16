// The YouTube miner: fetch a tutorial's transcript (yt-dlp subtitles), have the LLM extract
// the in-the-box technique it teaches as recipe cards, and VALIDATE each by symbolic
// conformance through the SAME loop the distiller + flywheel use. Conformant cards bake,
// tagged source:"youtube". The transcript GROUNDS which technique to encode; conformance
// proves it RUNS; "is it good" is inherited from the source producer + the deferred quality
// layer. Unrunnable extractions are LOGGED, not hidden. Visual MIDI-grid reading is the
// deferred C.2; this is the transcript path.
//
//   npm run yt-mine -- "https://www.youtube.com/watch?v=..." ["https://..."]
//   YT_URL="https://..." npm run yt-mine
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { MOSH_BIN } from "./agentEngine.mts";
import { loadEnvFiles, resolveProviders, callLLM } from "./llm.mts";
import { parseDistilledCards } from "../src/agent/knowledge/distill";
import { IN_THE_BOX_COMMANDS, BASE_TOKENS, DISTILL_SYS } from "../src/agent/knowledge/distillPrompt";
import { parseTranscript, buildMinerUser } from "../src/agent/knowledge/youtube";
import { runCandidateThroughLoop, type Outcome } from "./recipeLoop.mts";
import { upsertCards, writeCardsData, loadCards } from "./knowledgeStore.mts";
import { type BaseSpec } from "./recipeBase.mts";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/yt-mine");

const env = (): Record<string, string> => ({ MOSH_NO_AUDIO: "1" });

const ARRANGEMENTS: BaseSpec[] = [
  { baseId: "lofi-85-Am", tempo: 85, key: "A minor" },
  { baseId: "dark-70-Cm", tempo: 70, key: "C minor" },
];

function haveYtDlp(): boolean {
  try { execFileSync("yt-dlp", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

// Fetch the title + the (auto-)caption .vtt via yt-dlp (args passed directly — no shell, so
// the URL can't inject). Subtitles only (--skip-download): no video, no executable content.
function fetchCaptions(url: string): { transcript: string; title: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "ytmine-"));
  let title = "";
  try {
    title = execFileSync("yt-dlp", ["--skip-download", "--no-warnings", "--print", "%(title)s", url], { encoding: "utf8", timeout: 60_000 }).trim().split("\n")[0] || "";
  } catch { /* title best-effort */ }
  try {
    execFileSync("yt-dlp", ["--skip-download", "--no-warnings", "--write-auto-subs", "--write-subs",
      "--sub-langs", "en,en-US,en-orig,en.*", "--sub-format", "vtt", "-o", resolve(dir, "sub"), url], { stdio: "ignore", timeout: 120_000 });
  } catch { /* subs best-effort */ }
  const vtts = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".vtt")) : [];
  const transcript = vtts.length ? parseTranscript(readFileSync(resolve(dir, vtts[0]), "utf8")) : "";
  return { transcript, title };
}

type MinedOutcome = Outcome & { url: string; title: string };

async function main() {
  if (!existsSync(MOSH_BIN)) { console.error("Mosh not built:", MOSH_BIN); process.exit(2); }
  if (!haveYtDlp()) { console.error("yt-dlp not found on PATH — install it (brew install yt-dlp) to mine transcripts."); process.exit(2); }
  loadEnvFiles(UI_ROOT);
  const providers = resolveProviders(process.env.YT_MINE_PROVIDER);
  if (!providers.length) { console.error("no LLM provider — set keys in ui/.env.local"); process.exit(2); }
  const urls = [...process.argv.slice(2).filter((a) => /^https?:\/\//.test(a)), ...(process.env.YT_URL ? [process.env.YT_URL] : [])];
  if (!urls.length) { console.error('usage: npm run yt-mine -- "<youtube-url>" [more…]   (or YT_URL=…)'); process.exit(2); }
  try { execSync("pkill -f server.py", { stdio: "ignore" }); } catch { /* none */ }
  mkdirSync(OUT_DIR, { recursive: true });
  console.error(`\nYouTube miner · ${urls.length} url(s) · providers=[${providers.map((p) => p.id).join(", ")}] · transcript-grounded (keys by reference)\n`);

  const before = new Set(loadCards().map((c) => c.id));
  const outcomes: MinedOutcome[] = [];
  const skipped: { url: string; title: string; reason: string }[] = [];

  for (const url of urls) {
    const { transcript, title } = fetchCaptions(url);
    if (transcript.length < 80) {
      const reason = transcript ? "transcript too short" : "no captions available";
      skipped.push({ url, title, reason });
      console.error(`  ⃠ ${title || url}: ${reason} — skipped`);
      continue;
    }
    console.error(`  ▶ "${title || url}" (${transcript.length} chars)`);
    const user = buildMinerUser(transcript, { title, url });

    let reply = "";
    for (const p of providers) {
      reply = await callLLM(p, [{ role: "system", content: DISTILL_SYS }, { role: "user", content: user }], { maxTokens: 4000 });
      if (parseDistilledCards(reply, { commands: IN_THE_BOX_COMMANDS, tokens: BASE_TOKENS }).cards.length) break;
    }
    const { cards, rejects } = parseDistilledCards(reply, { commands: IN_THE_BOX_COMMANDS, tokens: BASE_TOKENS });
    for (const r of rejects) console.error(`     ✗ shape: ${r.reason}`);
    if (!cards.length) {
      skipped.push({ url, title, reason: "no encodable technique extracted" });
      console.error(`     — no runnable cards from this transcript`);
      continue;
    }
    for (const cand of cards) {
      const out = await runCandidateThroughLoop(cand, ARRANGEMENTS, {
        source: "youtube", env: env(),
        onResult: (baseId, res) => console.error(`     ${cand.meta.skill_name.slice(0, 38).padEnd(38)} · ${baseId.padEnd(11)} · ${res.conformant ? "✓" : res.inconclusive ? "?" : "✗"} ${res.detail}`),
      });
      outcomes.push({ ...out, url, title });
    }
  }

  const conformant = outcomes.filter((o) => o.card.status === "conformant").map((o) => o.card);
  const novel = conformant.filter((c) => !before.has(c.id));
  let baked = 0;
  if (conformant.length) { upsertCards(conformant); baked = writeCardsData(); }

  console.error(`\n${conformant.length}/${outcomes.length} mined candidate(s) conformant · ${novel.length} NEW · ${baked} shippable baked · ${skipped.length} url(s) yielded nothing`);
  for (const c of novel) console.error(`  ★ NEW (youtube): ${c.skill_name}`);

  writeFileSync(resolve(OUT_DIR, "report.md"), report(outcomes, skipped, novel));
  console.error(`Full report: ${resolve(OUT_DIR, "report.md")}`);
}

function report(outcomes: MinedOutcome[], skipped: { url: string; title: string; reason: string }[], novel: { id: string }[]): string {
  const L: string[] = [];
  const nConf = outcomes.filter((o) => o.card.status === "conformant").length;
  L.push(`# YouTube miner — recipe cards extracted from tutorial transcripts, validated by conformance\n`);
  L.push(`${outcomes.length} candidate(s) reached the loop from ${new Set(outcomes.map((o) => o.url)).size} url(s); ${skipped.length} url(s) yielded nothing.`);
  L.push(`\n**${nConf}/${outcomes.length} conformant · ${novel.length} NEW · baked into the KB (source:"youtube").**\n`);
  if (outcomes.length) {
    L.push(`| card | from | task | ${ARRANGEMENTS.map((a) => a.baseId).join(" | ")} | verdict |`);
    L.push(`|------|------|------|${ARRANGEMENTS.map(() => "----").join("|")}|---------|`);
    const novelIds = new Set(novel.map((c) => c.id));
    for (const o of outcomes) {
      const cells = ARRANGEMENTS.map((a) => { const p = o.perArr.find((x) => x.baseId === a.baseId); return p ? (p.res.conformant ? "✓" : p.res.inconclusive ? "?" : "✗") + (p.res.measured != null ? ` ${p.res.measured.toFixed(2)}` : "") : "–"; });
      L.push(`| ${o.card.skill_name}${novelIds.has(o.card.id) ? " ★" : ""} | ${(o.title || o.url).slice(0, 32)} | ${o.card.task_type} | ${cells.join(" | ")} | ${o.card.status} |`);
    }
  }
  if (skipped.length) {
    L.push(`\n## URLs that yielded nothing (logged, not hidden)\n`);
    for (const s of skipped) L.push(`- ${s.title || s.url} — ${s.reason}`);
  }
  L.push(`\n_The transcript grounds WHICH technique to encode; conformance proves it RUNS + reproduces. "Is it good" is inherited from the source producer + the deferred audio-quality layer. Visual MIDI-grid reading is the deferred C.2._\n`);
  return L.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
