// Client for the local spend-capped proxy. The browser only ever talks to same-origin
// /api/arena/* — keys live server-side. generate() composes the prompt from the shared
// kit, calls the model, strips fences, and assembles a sandbox-ready Candidate.

import { buildMessages } from "./prompts";
import { DEF } from "../reference/params";
import { TARGETS, uid, type Candidate, type Pass, type Target } from "./types";
import type { Theme } from "../kit/tokens";

export interface Provider { id: string; label: string; model: string }
export interface ProvidersResp { default: string | null; providers: Provider[] }
export interface Meter { spentUsd: number; capUsd: number; calls: number; stopped: boolean }

export async function getProviders(): Promise<ProvidersResp> {
  try {
    const r = await fetch("/api/arena/providers");
    if (!r.ok) return { default: null, providers: [] };
    return (await r.json()) as ProvidersResp;
  } catch {
    return { default: null, providers: [] };
  }
}

export async function getMeter(): Promise<Meter> {
  try {
    const r = await fetch("/api/arena/meter");
    if (!r.ok) return { spentUsd: 0, capUsd: 0, calls: 0, stopped: false };
    return (await r.json()) as Meter;
  } catch {
    return { spentUsd: 0, capUsd: 0, calls: 0, stopped: false };
  }
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  return t;
}

export interface GenReq {
  provider: string;
  target: Target;
  pass: Pass;
  theme?: Theme;
  seed?: string;
  /** cross-critique panel brief injected into the prompt (the "informed pass") */
  extraBrief?: string;
  /** short marker folded into the title, e.g. "⟳R2", so informed candidates are findable */
  titleTag?: string;
  /** lightbox note explaining the candidate's lineage */
  notes?: string;
}
export interface GenResult { ok: boolean; candidate?: Candidate; error?: string; cost?: number; ms?: number }

export async function generate(req: GenReq): Promise<GenResult> {
  const meta = TARGETS.find((t) => t.id === req.target)!;
  const kind = meta.kind;
  const theme: Theme = req.theme ?? "dark";
  const seed = req.seed ?? Math.random().toString(36).slice(2, 7);
  const { system, user } = buildMessages(req.target, req.pass, kind, theme, seed, req.extraBrief);

  let j: { content?: string; model?: string; cost?: number; ms?: number; error?: string };
  let status: number;
  try {
    const r = await fetch("/api/arena/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: req.provider,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: req.pass === "bolder" ? 0.9 : 0.55,
      }),
    });
    status = r.status;
    j = await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
  if (status === 402) return { ok: false, error: "spend cap reached — raise ARENA_SPEND_CAP_USD or reset" };
  if (status < 200 || status >= 300) return { ok: false, error: j.error || `model error (${status})` };

  let src = stripFences(String(j.content || ""));
  if (!src) return { ok: false, error: "model returned empty output" };
  if (kind === "glsl" && !src.startsWith("#version")) src = "#version 300 es\nprecision highp float;\n" + src;

  const candidate: Candidate = {
    id: uid(req.provider),
    title: req.titleTag ? `${meta.label} ${req.titleTag} · ${seed}` : `${meta.label} · ${seed}`,
    target: req.target,
    pass: req.pass,
    kind,
    model: j.model || req.provider,
    source: src,
    params: kind === "glsl" ? { ...DEF } : undefined,
    theme: kind === "html" ? theme : undefined,
    prompt: req.extraBrief ? "panel-informed" : "auto",
    seed,
    createdAt: Date.now(),
    notes: req.notes,
  };
  return { ok: true, candidate, cost: j.cost, ms: j.ms };
}
