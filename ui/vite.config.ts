import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Per-install id sent to the brain PROXY (supabase/functions/brain, see
// docs/brain-proxy/RUNBOOK.md) for its daily token-cap bookkeeping — never a secret,
// just a bucket key. Reused from the SAME ~/Library/Mosh/<session>/identity.json
// "uuid" field src/brain/BrainProxy.cpp's installId() and service/brain_client.py's
// _install_id() read/write, so whichever of the three processes runs first mints it
// and the others converge on it. MOSH_SELFTEST_SESSION mirrors the native harness's
// own isolation leaf (unset in normal dev use -> the real "session" dir); unset in
// dev, this whole module is unreachable anyway (proxy mode is opt-in below).
let _cachedInstallId: string | null = null;
function installId(env: Record<string, string>): string {
  if (env.MOSH_BRAIN_INSTALL_ID) return env.MOSH_BRAIN_INSTALL_ID;
  if (_cachedInstallId) return _cachedInstallId;
  const leaf = (env.MOSH_SELFTEST_SESSION || "").trim() || "session";
  const dir = join(homedir(), "Library", "Mosh", leaf);
  const file = join(dir, "identity.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed.uuid === "string" && parsed.uuid) {
      const uuidValue: string = parsed.uuid;   // JSON.parse is `any` — pin the type explicitly
      _cachedInstallId = uuidValue;
      return uuidValue;
    }
  } catch {
    /* file absent/unreadable/malformed -> mint one below */
  }
  const fresh = randomUUID();
  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ uuid: fresh }));
    }
  } catch {
    /* best-effort persistence only; an ephemeral id still lets the request through */
  }
  _cachedInstallId = fresh;
  return fresh;
}

// Brain proxy (dev) — keys live ONLY here (server side); the browser talks to
// same-origin /api/brain/* and never sees a credential. All three providers speak
// OpenAI-compatible /chat/completions. Mirrors design-lab/playground/vite.config.js.
// In the packaged app there is no Vite; a native brain_chat proxy serves the same
// route (see bridge.brainChat). With no keys set, the UI falls back to a mock brain.
//
// PROXY CUTOVER (docs/brain-proxy/RUNBOOK.md): when MOSH_BRAIN_PROXY_URL is set (in
// ui/.env.local, same as the provider keys), /api/brain/chat forwards to the deployed
// supabase/functions/brain edge function instead of reading a local provider key —
// dev then exercises the SAME proxy path the packaged app uses. Unset (the default),
// behaviour is exactly what it was before the proxy existed.
function moshiBrain(env: Record<string, string>): Plugin {
  type Prov = { url?: string; key?: string; model?: string; label: string };
  const P: Record<string, Prov> = {
    deepseek: { url: env.DEEPSEEK_BASE_URL, key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL, label: "DEEPSEEK" },
    openai:   { url: env.OPENAI_BASE_URL,   key: env.OPENAI_API_KEY,   model: env.OPENAI_MODEL,   label: "OPENAI" },
    xai:      { url: env.XAI_BASE_URL,      key: env.XAI_API_KEY,      model: env.XAI_MODEL,      label: "GROK" },
    // The MLX seat: an OpenAI-compatible local server (mlx_lm.server). Key is a
    // formality for local endpoints — default it so LOCAL_BASE_URL+MODEL suffice.
    local:    { url: env.LOCAL_BASE_URL,    key: env.LOCAL_API_KEY ?? (env.LOCAL_BASE_URL ? "local" : undefined), model: env.LOCAL_MODEL, label: "LOCAL" },
  };
  const ok = (n: string) => !!(P[n] && P[n].key && P[n].url && P[n].model);
  const def = ok(env.MOSHI_BRAIN_PROVIDER) ? env.MOSHI_BRAIN_PROVIDER : (Object.keys(P).find(ok) ?? null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (res: any, code: number, obj: unknown) => {
    res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj));
  };

  // Proxy-first: when MOSH_BRAIN_PROXY_URL is set, forward there instead of reading a
  // local provider key. Returns null on ANY failure (unreachable / non-2xx / malformed
  // / proxy URL unset) so the caller falls through to the direct-provider path below —
  // additive, never a regression from the pre-proxy behaviour.
  async function tryProxy(body: { messages?: unknown; provider?: string; temperature?: number }) {
    const proxyUrl = env.MOSH_BRAIN_PROXY_URL;
    if (!proxyUrl) return null;
    try {
      const r = await fetch(proxyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.MOSH_BRAIN_PROXY_APIKEY ? { apikey: env.MOSH_BRAIN_PROXY_APIKEY } : {}),
        },
        body: JSON.stringify({
          messages: body.messages, provider: body.provider, temperature: body.temperature,
          install_id: installId(env),
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) return null;
      // Normalized to the SAME shape the direct-provider path returns below — the
      // proxy deliberately never discloses which upstream provider served it.
      return { provider: "proxy", label: "MOSH BRAIN PROXY", model: "", ms: 0, content: j.content ?? "" };
    } catch {
      return null;   // network error reaching the proxy -> fall through
    }
  }

  return {
    name: "moshi-brain",
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use("/api/brain/providers", (_req: any, res: any) => {
        send(res, 200, { default: def, providers: Object.keys(P).filter(ok).map((n) => ({ id: n, label: P[n].label, model: P[n].model })) });
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use("/api/brain/chat", (req: any, res: any) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        let raw = "";
        req.on("data", (c: unknown) => (raw += c));
        req.on("end", async () => {
          try {
            const body = JSON.parse(raw || "{}");

            const proxied = await tryProxy(body);
            if (proxied) return send(res, 200, proxied);

            const name: string | null = ok(body.provider) ? body.provider : def;
            const p = name ? P[name] : null;
            if (!p) return send(res, 503, { error: "no provider configured — add a key to ui/.env.local (or set MOSH_BRAIN_PROXY_URL to use the brain proxy)" });
            const isReasoning = name === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(p.model ?? "");
            const payload: Record<string, unknown> = { model: p.model, messages: body.messages, response_format: { type: "json_object" } };
            if (isReasoning) payload.max_completion_tokens = 800;
            else { payload.max_tokens = 800; payload.temperature = body.temperature ?? 0.6; }
            const t0 = Date.now();
            const r = await fetch(`${p.url}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
              body: JSON.stringify(payload),
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const j: any = await r.json().catch(() => ({}));
            const ms = Date.now() - t0;
            if (!r.ok) return send(res, 502, { error: j.error ?? "upstream error", provider: name, ms });
            send(res, 200, { provider: name, label: p.label, model: p.model, ms, content: j.choices?.[0]?.message?.content ?? "" });
          } catch (e) {
            send(res, 500, { error: String((e as Error)?.message ?? e) });
          }
        });
      });
    },
  };
}

// Single-file build: viteSingleFile inlines ALL JS + CSS into one self-contained
// index.html — load-bearing for the JUCE WebView (its resource scheme won't run
// external module scripts). base: "./" keeps refs origin-free. 03 / 06 §1.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), ""); // "" → load ALL keys incl. unprefixed; SERVER-SIDE only, never bundled
  const plugins: Plugin[] = [react(), moshiBrain(env)];
  if (command === "build") plugins.splice(1, 0, viteSingleFile());
  return {
    plugins,
    base: "./",
    build: { outDir: "dist", emptyOutDir: true, target: "es2020", sourcemap: false },
    server: { port: 5173, strictPort: true },
  };
});
