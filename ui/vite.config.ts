import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { installId } from "./src/sessionIdentity";

// Per-install id sent to the brain PROXY (supabase/functions/brain, see
// docs/brain-proxy/RUNBOOK.md) for its daily token-cap bookkeeping — never a secret,
// just a bucket key. Normal dev uses the owner session; a harness persists only when
// its exact ownership marker exists. Unsafe explicit values remain ephemeral and
// cannot write owner or arbitrary identity files.
// Brain proxy (dev) — keys live ONLY here (server side); the browser talks to
// same-origin /api/brain/* and never sees a credential. All three providers speak
// OpenAI-compatible /chat/completions. Mirrors design-lab/playground/vite.config.js.
// In the packaged app there is no Vite; a native brain_chat proxy serves the same
// route (see bridge.brainChat). Keyless Vite dev may use the demo brain; packaged
// builds fail visibly and never substitute mock commands.
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
        // Hermetic e2e (playwright.config's webServer sets this): the suite's contract
        // is "the brain is unreachable under Playwright" (agent-loop.spec relies on the
        // chatWithFallback → loopBrainMock path; everything else falls back to the demo
        // brain). With the owner's real provider keys in ui/.env.local the endpoint is
        // LIVE — a real LLM answers with non-deterministic plans, and a hung upstream
        // costs seconds — so e2e forces the fast failure the specs were written for.
        if (env.MOSH_E2E_HERMETIC_BRAIN) return send(res, 503, { error: "hermetic e2e brain — unreachable by contract" });
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
  if (command === "build" && mode !== "production" && mode !== "e2e") {
    throw new Error(`${mode} mode is forbidden for packaged builds; use production or explicit e2e mode`);
  }
  if (command === "build" && mode !== "e2e" && process.env.NODE_ENV === "development") {
    throw new Error("NODE_ENV=development is forbidden for packaged builds; unset it or use explicit e2e mode");
  }
  if (command === "build" && mode !== "e2e" && env.VITE_MOSH_E2E_MOCK) {
    throw new Error("VITE_MOSH_E2E_MOCK is forbidden for packaged builds; use --mode e2e for browser-only test bundles");
  }
  const plugins: Plugin[] = [react(), moshiBrain(env)];
  if (command === "build") plugins.splice(1, 0, viteSingleFile());
  return {
    plugins,
    base: "./",
    build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", emptyOutDir: true, target: "es2020", sourcemap: false },
    server: { port: 5173, strictPort: true },
  };
});
