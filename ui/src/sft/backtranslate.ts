// Back-translation / self-instruct for the SFT corpus — the step the *chosen brain*
// unlocks. The importer slices (buildDataset.sliceProgramFull) carry only MECHANICAL
// templated utterances ("set the tempo to 132", "write a short pattern into the clip
// on the X track"). A real producer says "make it 132", "lay a quick melody on the
// keys", "gimme something dark in the verse". We use the brain to turn the templates
// into DIVERSE, natural instructions WITHOUT touching the verified target commands —
// classic instruction-backtranslation (Self-Alignment w/ Instruction Backtranslation,
// Self-Instruct), the validated way to synthesize tool-calling SFT data.
//
// Budget trick: we do NOT call the brain per slice (the corpus is 180k files →
// millions of slices). We back-translate each distinct *shape* once. A shape is the
// templated utterance with its variable parts (quoted track names, numbers) replaced
// by ordered slots {0},{1},…; the brain returns natural phrasings that KEEP the slots;
// we fill the slots per slice. ~10 distinct shapes → ~10 brain calls cover everything,
// and the model never sees a raw command name (so it writes intent, not API).

import type { RawExample } from "./buildDataset";
import { AGENT_COMMANDS } from "../agent/commands";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type BrainChat = (messages: ChatMessage[]) => Promise<string>;

const COMMAND_NAMES = new Set(AGENT_COMMANDS.map((c) => c.command));

// ── shape extraction ──────────────────────────────────────────────────────────
// Quoted track names ("Symp Piano {FG}") and numbers (132, 92.02, 4/4) are the
// variable parts. Replace each, in order of appearance, with {0},{1},… and record
// the captured token so we can fill it back. The quoted match is GREEDY (one region
// per line) so a name that itself contains quotes (e.g. a MIDI title like ""One
// Caress"") slots as a single token instead of exploding into per-track shapes — the
// slicer only ever emits ONE quoted track name per utterance.
const VAR_RE = /("[^\n]*")|(\d+(?:\.\d+)?(?:\/\d+)?)/g;

export function extractShape(utterance: string): { shape: string; tokens: string[] } {
  const tokens: string[] = [];
  const shape = utterance.replace(VAR_RE, (m, quoted) => {
    tokens.push(quoted ? String(quoted).slice(1, -1) : m); // drop the quotes for natural fill
    return `{${tokens.length - 1}}`;
  });
  return { shape, tokens };
}

/** The set of slot indices used in a string ("{0} … {1}" → {0,1}). */
export function placeholderSet(s: string): Set<number> {
  const out = new Set<number>();
  for (const m of s.matchAll(/\{(\d+)\}/g)) out.add(Number(m[1]));
  return out;
}

const setsEqual = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Fill {i} slots with the slice's actual tokens. */
export function fillTemplate(template: string, tokens: string[]): string {
  return template.replace(/\{(\d+)\}/g, (_, i) => tokens[Number(i)] ?? `{${i}}`);
}

/** A synthesized natural template is usable iff it keeps EXACTLY the shape's slots,
 *  is a sane length, differs from the mechanical seed, and leaks no command name. */
export function validateTemplate(template: string, shape: string): boolean {
  const t = template.trim();
  if (t.length < 3 || t.length > 200) return false;
  if (!setsEqual(placeholderSet(t), placeholderSet(shape))) return false;
  if (t.toLowerCase() === shape.toLowerCase()) return false;
  const lower = t.toLowerCase();
  for (const name of COMMAND_NAMES) if (lower.includes(name)) return false; // no API leakage
  return true;
}

// ── brain prompt + parse ────────────────────────────────────────────────────────
const SYS =
  "You rewrite a music-app instruction into how a real music producer would casually say it. " +
  "The app is a DAW assistant. Keep any {0},{1},… placeholders EXACTLY as given (they are track " +
  "names or numbers filled in later). Vary length, slang, and phrasing across the rewrites; some " +
  "terse, some chatty. Do NOT mention software commands, JSON, or APIs. Respond ONLY as " +
  '{"instructions": ["...", "..."]} — a JSON object with a string array.';

// Style axis for real diversity at scale (program Stage 1.1: "style-varied, terse
// producer-speak ↔ verbose beginner"). One brain call per style per shape; the
// default (no styles) keeps the original single-call behavior.
export const BT_STYLES = [
  "terse producer slang — clipped, lowercase, studio shorthand, no pleasantries",
  "plain everyday phrasing — neutral and direct",
  "verbose beginner — polite full sentences, may hedge or over-explain",
];

export function buildShapePrompt(shape: string, n: number, style?: string): ChatMessage[] {
  return [
    { role: "system", content: SYS },
    {
      role: "user",
      content:
        `Mechanical instruction: "${shape}"\n` +
        `Write ${n} distinct, natural producer phrasings of the SAME request. ` +
        (style ? `Voice: ${style}. ` : "") +
        `Keep the placeholders ${[...placeholderSet(shape)].map((i) => `{${i}}`).join(", ") || "(none)"} verbatim.`,
    },
  ];
}

/** Tolerant parse of the brain reply → array of instruction templates. */
export function parseInstructions(content: string): string[] {
  if (!content) return [];
  let txt = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  // Prefer a JSON object/array; fall back to the first [...] span.
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
  let v = tryParse(txt);
  if (v === undefined) {
    const i = txt.indexOf("["), j = txt.lastIndexOf("]");
    if (i >= 0 && j > i) v = tryParse(txt.slice(i, j + 1));
  }
  const arr = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as any).instructions) ? (v as any).instructions : [];
  return (arr as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
}

// ── the back-translator ──────────────────────────────────────────────────────────
export type BacktranslateOpts = {
  variants?: number;                 // natural utterances per shape (default 3; per STYLE when styles set)
  styles?: string[];                 // one brain call per style per shape (e.g. BT_STYLES)
  budget?: { calls: number };        // mutable remaining brain-call budget (shared)
  cache?: Map<string, string[]>;     // shape → validated templates (re-run idempotency)
  onShape?: (shape: string, templates: string[]) => void; // progress hook
};

export class Backtranslator {
  private chat: BrainChat;
  private variants: number;
  private styles: string[] | undefined;
  private budget: { calls: number };
  private cache: Map<string, string[]>;
  private onShape?: (s: string, t: string[]) => void;
  calls = 0;

  constructor(chat: BrainChat, opts: BacktranslateOpts = {}) {
    this.chat = chat;
    this.variants = opts.variants ?? 3;
    this.styles = opts.styles;
    this.budget = opts.budget ?? { calls: Infinity };
    this.cache = opts.cache ?? new Map();
    this.onShape = opts.onShape;
  }

  /** Snapshot the shape→templates cache (for persistence across runs). */
  cacheEntries(): [string, string[]][] { return [...this.cache]; }

  /** Natural templates for one shape (cached; budget-gated — one brain call per
   *  style when a style axis is set, else one call total). */
  async templatesFor(shape: string): Promise<string[]> {
    const hit = this.cache.get(shape);
    if (hit) return hit;
    const templates: string[] = [];
    const seen = new Set<string>();
    for (const style of this.styles ?? [undefined as string | undefined]) {
      if (this.budget.calls <= 0) break;
      this.budget.calls--;
      this.calls++;
      try {
        const reply = await this.chat(buildShapePrompt(shape, this.variants, style));
        let kept = 0;
        for (const t of parseInstructions(reply)) {
          const tt = t.trim();
          if (validateTemplate(tt, shape) && !seen.has(tt.toLowerCase())) { seen.add(tt.toLowerCase()); templates.push(tt); kept++; }
          if (kept >= this.variants) break;
        }
      } catch { /* a dud style call contributes nothing; others still count */ }
    }
    this.cache.set(shape, templates); // cache even [] so a dud shape isn't retried
    this.onShape?.(shape, templates);
    return templates;
  }

  /** Augment one raw with natural-utterance clones (same gold commands). The
   *  original templated raw is returned by the caller; this returns ONLY extras. */
  async variantsFor(raw: RawExample): Promise<RawExample[]> {
    const { shape, tokens } = extractShape(raw.utterance);
    const templates = await this.templatesFor(shape);
    const out: RawExample[] = [];
    for (let k = 0; k < templates.length; k++) {
      const utterance = fillTemplate(templates[k], tokens);
      if (!utterance.trim() || utterance === raw.utterance) continue;
      out.push({ ...raw, id: `${raw.id}~bt${k}`, utterance });
    }
    return out;
  }
}

// ── default real brain chat (mirrors evalSft.callBrain) ──────────────────────────
export function loadDotEnv(cwd = process.cwd()): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const path = resolve(cwd, ".env.local");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
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
  }
  return env;
}

/** Build a real OpenAI-compatible brain chat from env, or null if no key. */
export function makeBrainChat(env: Record<string, string> = loadDotEnv()): BrainChat | null {
  const provider = (env.MOSHI_BRAIN_PROVIDER || "openai").toLowerCase();
  const cfg: Record<string, { url: string; model: string; keyVar: string }> = {
    openai: { url: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.OPENAI_MODEL || "gpt-5.4-mini", keyVar: "OPENAI_API_KEY" },
    deepseek: { url: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", model: env.DEEPSEEK_MODEL || "deepseek-v4-flash", keyVar: "DEEPSEEK_API_KEY" },
    xai: { url: env.XAI_BASE_URL || "https://api.x.ai/v1", model: env.XAI_MODEL || "grok-4.3", keyVar: "XAI_API_KEY" },
  };
  const c = cfg[provider] ?? cfg.openai;
  const key = env[c.keyVar];
  if (!key) return null;
  const isReasoning = provider === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(c.model);
  return async (messages) => {
    const payload: Record<string, unknown> = { model: c.model, messages, response_format: { type: "json_object" } };
    if (isReasoning) payload.max_completion_tokens = 700; else { payload.max_tokens = 700; payload.temperature = 0.9; }
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const r = await fetch(`${c.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    } catch { return ""; }
    finally { clearTimeout(to); }
  };
}
