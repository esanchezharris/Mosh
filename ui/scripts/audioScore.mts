// Node wrapper around service/scripts/score_wav.py — batches WAVs through the
// hygiene (quality_readout) + perceptual (Audiobox) scorers in ONE python process
// (the judge model loads once). Returns a per-wav score + a triage verdict.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCORER = resolve(REPO, "service/scripts/score_wav.py");

export type WavScore = {
  file: string;
  pq_hygiene: number | null;
  pq_perceptual: number | null;
  clap_brief: number | null;   // CLAP text↔audio similarity to the brief (higher = on-brief)
  clap_sine: number | null;    // similarity to "a pure sine tone" (a sanity anti-reference)
  metrics: Record<string, unknown> | null;
  flags: string[];
  verdict: "pass" | "flag";
};

// quality_readout has soundfile+numpy; so does the judges venv. Prefer the judges
// venv so the perceptual sidecar (same interpreter) is reachable.
function scorerPython(): string {
  const cands = [process.env.MOSH_JUDGES_PY, `${homedir()}/AI/judges_venv/bin/python`, "python3"].filter(Boolean) as string[];
  for (const p of cands) if (p === "python3" || existsSync(p)) return p;
  return "python3";
}

const BROKEN = /clip|silent|silence|too_quiet|near_silent|dropout|tonal_suspect|off_brief|hygiene_failed|scorer/i;
const nul = (f: string): Omit<WavScore, "verdict"> => ({ file: f, pq_hygiene: null, pq_perceptual: null, clap_brief: null, clap_sine: null, metrics: null, flags: [] });

/** Score wavs. Pass `brief` to also get CLAP brief-adherence (needs the CLAP ckpt). */
export function scoreWavs(paths: string[], brief?: string): WavScore[] {
  const real = paths.filter((p) => existsSync(p));
  if (real.length === 0) return [];
  const env = { ...process.env, ...(brief ? { MOSH_BRIEF: brief } : {}) };
  const r = spawnSync(scorerPython(), [SCORER, ...real], { encoding: "utf8", timeout: 600_000, maxBuffer: 128 * 1024 * 1024, env });
  if (r.status !== 0 || !r.stdout) {
    return real.map((f) => ({ ...nul(f), flags: [`scorer_failed: ${(r.stderr || "").slice(0, 160)}`], verdict: "flag" }));
  }
  let arr: Omit<WavScore, "verdict">[];
  try { arr = JSON.parse(r.stdout.trim().split("\n").pop()!); }
  catch { return real.map((f) => ({ ...nul(f), flags: ["scorer_parse_failed"], verdict: "flag" })); }
  return arr.map((s) => ({ ...s, verdict: (s.flags || []).some((f) => BROKEN.test(f)) ? "flag" : "pass" }));
}
