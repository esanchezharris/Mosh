// Deterministic "rework the hook" resolver. Detects a generative-rework request aimed
// at a NAMED song section and turns it into a render SCOPED to that section's beat
// range — carried on the render layer as an explicit sub-region (no clip surgery). Pure
// (snapshot → real catalog commands), so it runs locally BEFORE the LLM and unit-tests
// without a model. Every emitted step is an existing MoshOps command; the setup runs as
// one undo batch via the same runAgentBatch path as any other agent turn.

import type { Snapshot, Section, Clip } from "../types";
import type { AgentCommandCall } from "./executor";

// The verbs that mean "regenerate this part with the generative model".
const REWORK =
  /\b(rework|re-?imagine|re-?invent|re-?do|redo|regenerate|re-?gen|re-?make|remake|transform|flip|switch up|spice up|mess with|mosh up|moshify)\b/;

// Extra labels a section answers to: a section literally named "hook" also responds to
// "chorus"/"refrain", etc. Keyed by the (lower-cased) section name → alias words.
const ALIASES: Record<string, string[]> = {
  hook: ["chorus", "refrain"],
  chorus: ["hook", "refrain"],
  drop: ["hook"],
  outro: ["ending", "tail"],
  intro: ["introduction"],
  bridge: ["middle eight", "middle 8"],
};

function normalize(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The section the utterance refers to (by name or a known alias), or null. */
export function matchSection(norm: string, sections: Section[]): Section | null {
  let best: { sec: Section; score: number } | null = null;
  for (const sec of sections) {
    const name = normalize(sec.name);
    if (!name) continue;
    const labels = [name, ...(ALIASES[name] ?? [])];
    for (const label of labels) {
      const l = normalize(label);
      if (!l) continue;
      if (new RegExp(`\\b${escapeRegex(l)}\\b`).test(norm) && (!best || l.length > best.score))
        best = { sec, score: l.length };
    }
  }
  return best?.sec ?? null;
}

/** The wave clip with the largest overlap of [startSec, endSec), or null. */
function overlapClip(snapshot: Snapshot, startSec: number, endSec: number) {
  let best: { clip: Clip; trackId: string; overlap: number } | null = null;
  for (const t of snapshot.tracks ?? [])
    for (const c of t.clips ?? []) {
      if (c.type !== "wave") continue;
      const cs = c.start;
      const ce = c.start + c.length;
      const overlap = Math.min(ce, endSec) - Math.max(cs, startSec);
      if (overlap > 1e-3 && (!best || overlap > best.overlap)) best = { clip: c, trackId: t.id, overlap };
    }
  return best ? { clip: best.clip, trackId: best.trackId } : null;
}

// An optional steer pulled from the tail of the utterance: "rework the hook INTO
// something darker" → "something darker". Conservative — only a few lead-ins, so a bare
// "rework the hook" stays prompt-less (the model re-imagines without a text steer).
function extractPrompt(text: string): string | undefined {
  const m = String(text ?? "").match(/\b(?:into|to be|to sound|as|like|make it|more)\b\s+(.{2,80}?)\s*$/i);
  const p = m?.[1]?.trim();
  return p && p.length >= 2 ? p : undefined;
}

export type SectionRework =
  | {
      kind: "ok";
      section: Section;
      clip: Clip;
      trackId: string;
      regionStart: number; // seconds, clamped to the clip
      regionEnd: number;
      prompt?: string;
    }
  | { kind: "empty"; section: Section; reason: string }; // section found, but nothing to rework

/**
 * Resolve a "rework the <section>" request to a section-scoped render. Returns null when
 * the utterance isn't a rework request, names no known section, or there are no sections
 * — so the caller falls through to the LLM brain unchanged.
 */
export function resolveSectionRework(text: string, snapshot: Snapshot | null): SectionRework | null {
  if (!snapshot) return null;
  const norm = normalize(text);
  if (!REWORK.test(norm)) return null;

  const sections = snapshot.sections ?? [];
  if (sections.length === 0) return null;

  const section = matchSection(norm, sections);
  if (!section) return null;

  const tempo = snapshot.session?.tempo || 120;
  const beatSec = 60 / tempo;
  const startSec = section.startBeat * beatSec;
  const endSec = section.endBeat * beatSec;

  const hit = overlapClip(snapshot, startSec, endSec);
  if (!hit) return { kind: "empty", section, reason: `nothing in the ${section.name} to rework yet` };

  const cs = hit.clip.start;
  const ce = hit.clip.start + hit.clip.length;
  const regionStart = Math.max(startSec, cs);
  const regionEnd = Math.min(endSec, ce);
  return { kind: "ok", section, clip: hit.clip, trackId: hit.trackId, regionStart, regionEnd, prompt: extractPrompt(text) };
}

/**
 * The real catalog commands that scope a generative render to the section's clip region.
 * If the clip already carries a layer it's cleared first (so the new region takes), then
 * a region-scoped layer is attached, optionally steered, kicked off, and the transport
 * loop is parked over the section so the scope is visible/auditionable. Runs as one
 * undo batch.
 */
export function planSectionRework(r: Extract<SectionRework, { kind: "ok" }>): AgentCommandCall[] {
  const cmds: AgentCommandCall[] = [];
  if (r.clip.hasRenderLayer) cmds.push({ command: "remove_render_layer", args: { clipId: r.clip.id } });
  cmds.push({
    command: "create_render_layer",
    args: { clipId: r.clip.id, regionStart: r.regionStart, regionEnd: r.regionEnd },
  });
  if (r.prompt) cmds.push({ command: "set_render_param", args: { clipId: r.clip.id, prompt: r.prompt } });
  cmds.push({ command: "render_layer", args: { clipId: r.clip.id } });
  cmds.push({
    command: "set_transport",
    args: { action: "seek", position: r.regionStart, loopStart: r.regionStart, loopEnd: r.regionEnd },
  });
  return cmds;
}
