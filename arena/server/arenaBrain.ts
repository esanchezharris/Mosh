// ============================================================================
// ARENA BRAIN — the local, spend-capped model proxy (dev middleware). Mirrors Mosh's
// moshiBrain: keys live ONLY here (server-side, from arena/.env.local), the browser
// talks to same-origin /api/arena/* and never sees a credential. Every provider is
// reached via its OpenAI-COMPATIBLE /chat/completions endpoint, so this stays one
// simple path. Every call is METERED and a HARD per-session USD cap STOPS generation.
// ============================================================================

import type { Plugin } from "vite";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

interface Prov { url: string; key?: string; model?: string; label: string; priceIn: number; priceOut: number }

const SPEND_FILE = resolve(process.cwd(), ".arena-spend.json");
const LIB_DIR = resolve(process.cwd(), "library");
// The whole generated wall, persisted server-side so EVERY browser/device (incl. the iPhone
// over the LAN) loads the complete history — not just the browser that generated a candidate.
const GEN_FILE = resolve(process.cwd(), ".arena-generated.json");
// Judging verdicts (keep/cull), persisted server-side so a Safari-on-iPhone pass isn't lost
// with the tab. Map of candidate id → {v, at}; last-write-wins by `at`.
const VERD_FILE = resolve(process.cwd(), ".arena-verdicts.json");

type VerdictEntry = { v: "promoted" | "culled" | null; at: number };
function readVerdicts(): Record<string, VerdictEntry> {
  try {
    return existsSync(VERD_FILE) ? (JSON.parse(readFileSync(VERD_FILE, "utf8")) as Record<string, VerdictEntry>) : {};
  } catch {
    return {};
  }
}
function writeVerdicts(map: Record<string, VerdictEntry>) {
  try {
    writeFileSync(VERD_FILE, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function readGen(): any[] {
  try {
    return existsSync(GEN_FILE) ? (JSON.parse(readFileSync(GEN_FILE, "utf8")) as any[]) : [];
  } catch {
    return [];
  }
}
function writeGen(arr: any[]) {
  try {
    writeFileSync(GEN_FILE, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

export function arenaBrain(env: Record<string, string>): Plugin {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(+v) ? +v : d);

  // provider table — OpenAI-compatible endpoints. Base URLs overridable via *_BASE_URL.
  const P: Record<string, Prov> = {
    anthropic: {
      url: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
      key: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, label: "CLAUDE",
      priceIn: num(env.PRICE_ANTHROPIC_IN, 8), priceOut: num(env.PRICE_ANTHROPIC_OUT, 30),
    },
    openai: {
      url: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, label: "GPT",
      priceIn: num(env.PRICE_OPENAI_IN, 5), priceOut: num(env.PRICE_OPENAI_OUT, 15),
    },
    gemini: {
      url: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, label: "GEMINI",
      priceIn: num(env.PRICE_GEMINI_IN, 2), priceOut: num(env.PRICE_GEMINI_OUT, 8),
    },
    xai: {
      url: env.XAI_BASE_URL || "https://api.x.ai/v1",
      key: env.XAI_API_KEY, model: env.XAI_MODEL, label: "GROK",
      priceIn: num(env.PRICE_XAI_IN, 3), priceOut: num(env.PRICE_XAI_OUT, 15),
    },
    openrouter: {
      url: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL, label: "OPENROUTER",
      priceIn: num(env.PRICE_OPENROUTER_IN, 3), priceOut: num(env.PRICE_OPENROUTER_OUT, 15),
    },
    deepseek: {
      url: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL, label: "DEEPSEEK",
      priceIn: num(env.PRICE_DEEPSEEK_IN, 0.3), priceOut: num(env.PRICE_DEEPSEEK_OUT, 1.2),
    },
    kimi: {
      url: env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
      key: env.KIMI_API_KEY, model: env.KIMI_MODEL, label: "KIMI",
      priceIn: num(env.PRICE_KIMI_IN, 1), priceOut: num(env.PRICE_KIMI_OUT, 3),
    },
  };
  const configured = (n: string) => !!(P[n] && P[n].key && P[n].model);
  const CAP = num(env.ARENA_SPEND_CAP_USD, 5);

  // ── spend state (persisted so the cap survives dev-server restarts) ──
  let spentUsd = 0;
  let calls = 0;
  try {
    if (existsSync(SPEND_FILE)) {
      const s = JSON.parse(readFileSync(SPEND_FILE, "utf8"));
      spentUsd = +s.spentUsd || 0; calls = +s.calls || 0;
    }
  } catch { /* fresh session */ }
  const persist = () => { try { writeFileSync(SPEND_FILE, JSON.stringify({ spentUsd, calls, capUsd: CAP })); } catch { /* ignore */ } };

  const send = (res: ServerResponse, code: number, obj: unknown) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };
  const readJson = (req: IncomingMessage) =>
    new Promise<any>((ok) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { try { ok(JSON.parse(raw || "{}")); } catch { ok({}); } }); });

  const estTokens = (msgs: { content: string }[]) => Math.ceil(msgs.reduce((n, m) => n + (m.content?.length || 0), 0) / 4);

  return {
    name: "arena-brain",
    configureServer(server) {
      server.middlewares.use("/api/arena/providers", (_req, res) => {
        send(res, 200, {
          default: Object.keys(P).find(configured) ?? null,
          providers: Object.keys(P).filter(configured).map((id) => ({ id, label: P[id].label, model: P[id].model })),
        });
      });

      server.middlewares.use("/api/arena/meter", (_req, res) =>
        send(res, 200, { spentUsd, capUsd: CAP, calls, stopped: spentUsd >= CAP }));

      server.middlewares.use("/api/arena/chat", async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        if (spentUsd >= CAP) return send(res, 402, { error: `spend cap reached ($${spentUsd.toFixed(2)}/$${CAP.toFixed(2)})` });
        const body = await readJson(req);
        const name: string = configured(body.provider) ? body.provider : (Object.keys(P).find(configured) ?? "");
        const p = P[name];
        if (!p) return send(res, 503, { error: "no provider configured — add a key to arena/.env.local" });

        // OpenAI reasoning models (gpt-5/o-series) use max_completion_tokens + reject temperature.
        // Anthropic's opus/sonnet reject temperature too. Everything else takes max_tokens + temperature.
        const isOpenAIReasoning = name === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(p.model || "");
        const noTemperature = isOpenAIReasoning || name === "anthropic";
        const payload: Record<string, unknown> = { model: p.model, messages: body.messages };
        // reasoning models spend completion budget on internal thinking first, so give them
        // ample room or they return empty (all budget consumed before any visible output).
        if (isOpenAIReasoning) payload.max_completion_tokens = 20000;
        else payload.max_tokens = 4000;
        if (!noTemperature) payload.temperature = body.temperature ?? 0.7;

        const t0 = Date.now();
        try {
          const r = await fetch(`${p.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
            body: JSON.stringify(payload),
          });
          const j: any = await r.json().catch(() => ({}));
          const ms = Date.now() - t0;
          if (!r.ok) return send(res, 502, { error: j.error?.message || j.error || `upstream ${r.status}`, provider: name, ms });

          const usage = j.usage || {};
          const inTok = usage.prompt_tokens ?? estTokens(body.messages || []);
          const outTok = usage.completion_tokens ?? Math.ceil((j.choices?.[0]?.message?.content?.length || 0) / 4);
          const cost = (inTok / 1e6) * p.priceIn + (outTok / 1e6) * p.priceOut;
          spentUsd += cost; calls += 1; persist();

          send(res, 200, {
            provider: name, label: p.label, model: p.model, ms,
            content: j.choices?.[0]?.message?.content ?? "",
            cost: +cost.toFixed(4), usage: { inTok, outTok }, spentUsd: +spentUsd.toFixed(4), capUsd: CAP,
          });
        } catch (e) {
          send(res, 500, { error: String((e as Error)?.message ?? e) });
        }
      });

      // The durable generated wall. GET returns everything ever generated; POST upserts one
      // or many candidates (dedupe/replace by id). Read+merge+write is a single synchronous
      // block so concurrent POSTs during a batch can't race on the file.
      server.middlewares.use("/api/arena/generated", async (req, res) => {
        if (req.method === "GET") return send(res, 200, { candidates: readGen() });
        if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
        const body = await readJson(req);
        const incoming: any[] = Array.isArray(body) ? body : body && body.id ? [body] : body?.candidates ?? [];
        const cur = readGen();
        const byId = new Map<string, any>(cur.map((c) => [c.id, c]));
        let added = 0;
        for (const c of incoming) if (c && c.id) { if (!byId.has(c.id)) added++; byId.set(c.id, c); }
        const merged = Array.from(byId.values());
        writeGen(merged);
        send(res, 200, { ok: true, count: merged.length, added });
      });

      // Judging verdicts. GET returns the whole map; POST upserts one or many entries
      // ({id, v, at} | [{...}] | {entries:[...]}) with last-write-wins by `at`, or
      // {clearAll:true} to wipe. Read-merge-write is synchronous (no cross-POST races).
      server.middlewares.use("/api/arena/verdicts", async (req, res) => {
        if (req.method === "GET") return send(res, 200, { verdicts: readVerdicts() });
        if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
        const body = await readJson(req);
        if (body && body.clearAll === true) {
          writeVerdicts({});
          return send(res, 200, { ok: true, count: 0 });
        }
        const incoming: any[] = Array.isArray(body) ? body : body && body.id ? [body] : body?.entries ?? [];
        const cur = readVerdicts();
        let applied = 0;
        for (const e of incoming) {
          if (!e || typeof e.id !== "string") continue;
          const at = typeof e.at === "number" ? e.at : 0;
          const v = e.v === "promoted" || e.v === "culled" ? e.v : null;
          const prev = cur[e.id];
          if (!prev || at >= prev.at) { cur[e.id] = { v, at }; applied++; }
        }
        writeVerdicts(cur);
        send(res, 200, { ok: true, applied, count: Object.keys(cur).length });
      });

      // best-effort: persist a winner to a git-committable JSON under arena/library/
      server.middlewares.use("/api/arena/save", async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        const cand = await readJson(req);
        if (!cand || !cand.id) return send(res, 200, { ok: false });
        try {
          if (!existsSync(LIB_DIR)) mkdirSync(LIB_DIR, { recursive: true });
          const safe = String(cand.id).replace(/[^a-z0-9_-]/gi, "_");
          writeFileSync(resolve(LIB_DIR, `${safe}.json`), JSON.stringify(cand, null, 2));
          send(res, 200, { ok: true });
        } catch (e) {
          send(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
        }
      });
    },
  };
}
