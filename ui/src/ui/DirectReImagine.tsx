import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Clip, CommandResult, RenderLayer, Track } from "../types";
import { amountToNl, nlToAmount } from "./reimagineAmount";

const MAX_SEED = 2147483647;

// When each render began, keyed by the engine's requestId (render_layer answers with it,
// and the layer carries it while queued/rendering). Module-level so the clock survives the
// inspector closing and reopening mid-render — GenDrawer keys this component on the clip.
// A render this UI started is stamped with its Generate CLICK (the submit itself can take
// a cold service spawn); one it did not start (a Keep validation, another surface) is
// stamped when first seen. Elapsed time is the only claim made: no expected duration is
// shown, because none has been measured.
const renderStartedAt = new Map<string, number>();
function rememberStart(requestId: string, at: number) {
  if (renderStartedAt.has(requestId)) return;
  renderStartedAt.set(requestId, at);
  if (renderStartedAt.size > 64) {
    const oldest = renderStartedAt.keys().next().value;
    if (oldest !== undefined) renderStartedAt.delete(oldest);
  }
}
function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function resultStatus(layer: RenderLayer | undefined): string {
  if (!layer) return "Ready to generate";
  switch (layer.status) {
    case "queued": return "Queued";
    case "rendering": return "Running";
    case "cancelled": return "Result cancelled. Inference may still be running; its output will not be applied.";
    case "error": return layer.error || "Generation failed";
    case "ready": return layer.hasPending ? "Result ready to audition" : layer.userKept ? "Result kept" : "Ready to generate";
    case "empty": case "dirty": case "bypassed": case "frozen": case "bounced":
      return layer.hasPending ? "Result ready to audition" : "Ready to generate";
  }
}

export function DirectReImagine({ clip, track }: { readonly clip: Clip; readonly track: Track }) {
  const exec = useStore((state) => state.exec);
  const available = useStore((state) => state.sa3Available);
  const explicitDecisions = useStore((state) => state.explicitRenderDecision);
  const testFixture = useStore((state) => state.directRenderTestFixture);
  const serviceState = useStore((state) => state.genServiceState);
  const serviceError = useStore((state) => state.genServiceError);
  const loadColors = useStore((state) => state.loadColors);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const layer = clip.renderLayer;
  const [prompt, setPrompt] = useState(layer?.prompt ?? "");
  const [nl, setNl] = useState(layer?.nl ?? 0.4);
  const [seed, setSeed] = useState(String(layer?.seed ?? 0));
  // True once the user edits the seed field; a typed seed is always sent exactly as typed.
  const [seedTyped, setSeedTyped] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clickedAt, setClickedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const latestLayer = useRef(layer);
  latestLayer.current = layer;
  useEffect(() => { void loadColors(true); }, [loadColors]);
  useEffect(() => {
    setPrompt(layer?.prompt ?? ""); setNl(layer?.nl ?? 0.4); setSeed(String(layer?.seed ?? 0)); setSeedTyped(false);
  }, [layer?.id, layer?.prompt, layer?.nl, layer?.seed]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const current = latestLayer.current;
      if (useStore.getState().projectEpoch === projectEpoch && current?.decisionPolicy === "explicit") {
        void exec("bypass_layer", { clipId: clip.id, audition: "committed" });
      }
    };
  }, [clip.id, exec, projectEpoch]);
  const current = () => active.current && useStore.getState().projectEpoch === projectEpoch;
  const running = layer?.status === "queued" || layer?.status === "rendering";
  const busy = submitting || running;
  const legacy = !!layer && layer.decisionPolicy !== "explicit";
  const validSeed = seed.trim() !== "" && Number.isSafeInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 2147483647;
  const hasPending = layer?.hasPending === true;
  const fixtureMode = testFixture && explicitDecisions === true;
  const unavailable = explicitDecisions !== true || (available !== true && !fixtureMode);
  const hasResult = hasPending || layer?.userKept === true;
  const unsupported = clip.loopEnabled || clip.reversed || clip.autoTempo;
  const sourceStart = layer?.sourceStart ?? clip.offset;
  const sourceDuration = layer?.sourceDuration ?? clip.length;
  const commandResult = async (name: string, args: Record<string, unknown>): Promise<CommandResult | null> => {
    if (!current()) return null;
    const result = await exec(name, args);
    if (!current()) return null;
    if (!result.ok) setError(result.error || "The operation could not be completed.");
    return result;
  };
  const command = async (name: string, args: Record<string, unknown>) => (await commandResult(name, args))?.ok === true;
  const generate = async () => {
    if (busy || unavailable || legacy || unsupported || !validSeed) return;
    // "Generate again" with a seed nobody touched would re-run the identical render: step
    // it by one and SHOW the new value. A typed seed (even the same number) is a deliberate
    // choice and goes exactly as typed.
    const hadResult = !!layer && (layer.hasArtifact || layer.userKept || hasPending);
    const nextSeed = hadResult && !seedTyped && Number(seed) === layer.seed
      ? (layer.seed + 1) % (MAX_SEED + 1)
      : Number(seed);
    if (String(nextSeed) !== seed) setSeed(String(nextSeed));
    const started = Date.now();
    setClickedAt(started); setNow(started);
    setSubmitting(true); setError(null);
    try {
      if (!layer && !await command("create_render_layer", {
        clipId: clip.id, decisionPolicy: "explicit", adapter: "stable_audio3", mode: "reimagine", modelVariant: "sa3-medium",
      })) return;
      if (!await command("set_render_param", { clipId: clip.id, prompt, nl, seed: nextSeed })) return;
      const rendered = await commandResult("render_layer", { clipId: clip.id });
      const requestId = rendered?.ok ? (rendered.data as { requestId?: unknown } | undefined)?.requestId : undefined;
      if (typeof requestId === "string" && requestId) rememberStart(requestId, started);
    } catch (reason) {
      if (!(reason instanceof Error)) throw reason;
      if (current()) setError(reason.message);
    } finally {
      if (current()) { setSubmitting(false); setClickedAt(null); }
    }
  };
  // A render already running whose start this UI never saw: count from first sight. The
  // real time, not `now` — that state only ticks while a clock is showing, so it can be
  // minutes stale here. (Idempotent: a stamp is written once per requestId.)
  if (running && layer?.requestId) rememberStart(layer.requestId, Date.now());
  const startedAt = submitting ? clickedAt
    : running && layer?.requestId ? renderStartedAt.get(layer.requestId) ?? null
    : null;
  const ticking = startedAt !== null;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const statusText = submitting ? "Submitting" : resultStatus(layer);
  const statusLine = startedAt !== null ? `${statusText} · ${elapsedLabel(now - startedAt)}` : statusText;
  const audition = layer?.audition ?? "committed";
  return <div className="gen direct-reimagine" data-testid="generative" data-render-status={layer?.status ?? "empty"}>
    <div className="gen-head">
      <span className="gen-title">RE-IMAGINE</span>
      <span className={`engine-badge eb-${!unavailable && !fixtureMode ? "sa3" : "preview"}`} data-testid="engine-badge">
        {fixtureMode || layer?.testFixture ? "Test fixture" : !unavailable ? "SA3" : "Direct SA3 unavailable"}
      </span>
    </div>
    <div className="direct-reimagine-target" data-testid="gen-target">
      <strong>{clip.name}</strong><span>{track.name}</span>
      <span>Original source: {sourceStart.toFixed(2)}–{(sourceStart + sourceDuration).toFixed(2)} s · {sourceDuration.toFixed(2)} s</span>
    </div>
    {(fixtureMode || layer?.testFixture) && <p role="status">Deterministic test fixture. Generated output is test audio, not an SA3 model render.</p>}
    {legacy ? <div className="gen-service-status" role="status">
      <span>This clip has a legacy render layer. Remove it explicitly before using the direct workflow.</span>
      <button className="btn" onClick={() => void command("remove_render_layer", { clipId: clip.id })}>Remove layer</button>
    </div> : <>
      {unavailable && <div className="gen-service-status" role="status" data-testid="gen-service-unavailable">
        <span>{serviceState === "idle" || serviceState === "warming" ? "Checking local SA3 service…"
          : serviceError || (explicitDecisions !== true
            ? (serviceState === "ready"
              // The service answered, but without direct render: the shared helper, which
              // GenerativeJobManager prefers over the bundled service, predates this Mosh.
              ? "The Re-Imagine helper in ~/Library/Application Support/Mosh/ReImagine/service is older than this Mosh (no direct render). Refresh it, then press Retry."
              : "The local service does not support direct Re-Imagine. Use the matching Mosh service, then retry.")
            : "Local SA3 is unavailable. Check that its service and model are available, then retry.")}</span>
        <button className="btn" type="button" onClick={() => void loadColors(true)}>Retry</button>
      </div>}
      <label className="direct-reimagine-field">Prompt
        <input className="gen-compile-input" data-testid="gen-prompt" data-owns-edit-keys="" value={prompt} disabled={busy}
          placeholder="Describe the sound to generate" onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <label className="nparam" title="Generation strength. Notes, lyrics and timing are not guaranteed to be preserved.">
        <span className="nlabel">Amount</span>
        <span className="nslider"><input type="range" min={0} max={100} step={1} data-testid="gen-nl"
          aria-label="Generation strength" disabled={busy} value={nlToAmount(nl, false)}
          onChange={(event) => setNl(amountToNl(Number(event.target.value), false))} /></span>
        <span className="nval">{nlToAmount(nl, false)}</span>
      </label>
      <label className="direct-reimagine-field">Seed
        <input type="number" min={0} max={2147483647} step={1} data-testid="gen-seed-input" data-owns-edit-keys=""
          value={seed} disabled={busy} aria-invalid={!validSeed} onChange={(event) => { setSeed(event.target.value); setSeedTyped(true); }} />
      </label>
      {!validSeed && <p role="alert">Enter a whole-number seed from 0 to 2147483647.</p>}
      {unsupported && <p role="alert">Use an ordinary audio clip without looping, reverse or tempo warp for this workflow.</p>}
      <div className="gen-service-status" role={layer?.status === "error" ? "alert" : "status"} data-testid="gen-status">
        {statusLine}
      </div>
      {error && <div className="gen-service-error" role="alert">{error}</div>}
      <div className="gen-actions">
        <button className="btn" data-testid="gen-render" disabled={busy || unavailable || !!unsupported || !validSeed}
          onClick={() => void generate()}>{hasPending ? "Discard pending and generate" : layer?.hasArtifact || layer?.userKept ? "Generate again" : "Generate"}</button>
        {running && <button className="btn" data-testid="gen-cancel" title="Cancel applying the result; inference may continue."
          onClick={() => void command("cancel_render", { clipId: clip.id, jobId: layer?.jobId, requestId: layer?.requestId })}>Cancel result</button>}
      </div>
      {layer && <>
        <div className="gen-actions" role="group" aria-label="Audition in session">
          <button className="btn" data-testid="gen-source" disabled={busy} aria-pressed={audition === "source"}
            onClick={() => void command("bypass_layer", { clipId: clip.id, audition: "source" })}>Source</button>
          <button className="btn" data-testid="gen-result" disabled={busy || !hasResult} aria-pressed={audition === "result"}
            onClick={() => void command("bypass_layer", { clipId: clip.id, audition: "result" })}>Result</button>
          <button className="btn" data-testid="gen-stop-audition" disabled={busy || audition === "committed"}
            onClick={() => void command("bypass_layer", { clipId: clip.id, audition: "committed" })}>Stop audition</button>
        </div>
        <p className="direct-reimagine-hint">Use the session transport to listen. Only the chosen source plays through this clip.</p>
        <div className="gen-actions">
          <button className="btn" data-testid="gen-accept" disabled={busy || !hasPending}
            onClick={() => void command("accept_render", { clipId: clip.id })}>Keep</button>
          <button className="btn" data-testid="gen-reject" disabled={busy || !hasPending}
            onClick={() => void command("reject_render", { clipId: clip.id })}>Reject</button>
          <button className="btn" disabled={busy} onClick={() => void command("remove_render_layer", { clipId: clip.id })}>Remove layer</button>
        </div>
      </>}
    </>}
  </div>;
}
