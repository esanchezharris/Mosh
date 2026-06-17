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

// ── Playlist mining at scale ──────────────────────────────────────────────────
// Pure URL helpers so the miner can take a whole tutorial PLAYLIST: classify a URL,
// pull the video id, and select a deduped, capped batch. The yt-dlp expansion itself
// (the I/O) lives in the script; this is the testable selection logic.

/** The 11-ish-char YouTube video id from a watch / youtu.be / shorts URL, else null. */
export function videoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v) return v;
    if (u.hostname === "youtu.be" || u.hostname.endsWith(".youtu.be")) return u.pathname.replace(/^\/+/, "").split("/")[0] || null;
    const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** True when a URL names a playlist to expand (a playlist page, or a watch URL with list=). */
export function isPlaylistUrl(url: string): boolean {
  try { return new URL(url).searchParams.has("list"); } catch { return false; }
}

const canonVideoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** Canonicalize candidate video URLs to bare watch URLs, dedup by id (first wins), drop the
 *  already-mined `seen` ids and anything without a video id, and cap the batch. Order kept. */
export function selectVideoUrls(videoUrls: string[], opts: { seen?: Set<string>; cap?: number } = {}): string[] {
  const seen = opts.seen ?? new Set<string>();
  const used = new Set<string>();
  const picked: string[] = [];
  for (const url of videoUrls) {
    const id = videoIdFromUrl(url);
    if (!id || used.has(id) || seen.has(id)) continue;
    used.add(id);
    picked.push(canonVideoUrl(id));
    if (opts.cap && picked.length >= opts.cap) break;
  }
  return picked;
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
