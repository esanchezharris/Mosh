// Pure helpers for the YouTube miner (scripts/ytMiner.mts): turn a tutorial's caption
// file into clean prose, and frame it as a transcript-grounded recipe-card extraction
// prompt. The miner emits the SAME $token recipe-card shape the distiller does (it shares
// distillPrompt.recipeCardRules), so a mined card parses + runs through the same loop.
// Pure (no node) so it unit-tests; the yt-dlp fetch + the loop live in the script.
import { recipeCardRules } from "./distillPrompt";

// WebVTT / SRT captions → prose: drop the header + cue-timing + numeric-index lines, strip
// inline <...> tags (auto-caption word timings + <c> spans), and collapse the rolling
// repeats auto-captions emit (each cue restates the tail of the previous one).
export function parseTranscript(captions: string): string {
  const out: string[] = [];
  let last = "";
  for (const raw of String(captions || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT" || /^(Kind|Language|NOTE|STYLE|REGION)\b/i.test(line)) continue;
    if (line.includes("-->")) continue;       // cue timing
    if (/^\d+$/.test(line)) continue;          // SRT numeric index
    line = line.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const norm = line.toLowerCase();
    if (norm === last) continue;               // exact rolling repeat
    out.push(line);
    last = norm;
  }
  return out.join(" ");
}

const TRANSCRIPT_BUDGET = 8000; // chars — keep the prompt inside a comfortable context

export function buildMinerUser(transcript: string, meta: { title?: string; url?: string }): string {
  const clipped = transcript.length > TRANSCRIPT_BUDGET ? transcript.slice(0, TRANSCRIPT_BUDGET) + " …[truncated]" : transcript;
  return [
    `Below is the TRANSCRIPT of a music-production tutorial${meta.title ? ` titled "${meta.title}"` : ""}.`,
    `Extract ONLY the in-the-box technique(s) this tutorial actually teaches/demonstrates, as recipe cards. If it doesn't teach a concrete in-the-box move you can encode with the commands below, return {"cards":[]} — do NOT invent technique the transcript doesn't show.`,
    ``,
    ...recipeCardRules(),
    ``,
    `TRANSCRIPT:`,
    clipped,
  ].join("\n");
}
