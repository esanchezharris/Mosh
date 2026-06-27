// The TEARDOWN tab of the browser drawer — turn a tutorial into a starting point.
// Two steps, both command-only (teardown_analyze → teardown_render → import_clip):
//   1. Analyze: paste a tutorial URL/id → the teardown service (§4) returns a Recipe
//      skeleton (detected tempo/key/plugins/sections) + a recipe path.
//   2. Reconstruct: render that Recipe (§9) to a reconstruction WAV and import it onto the
//      selected track. Both legs degrade gracefully when the teardown service isn't set up
//      (available:false → a setup hint, never a hard error).

import { useState } from "react";
import { useStore } from "../store";

interface Detected {
  daw?: string; tempo?: number | null; key?: string | null; plugins?: string[]; pianoroll?: boolean;
}

export function TeardownPanel() {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const [vid, setVid] = useState("");
  const [busy, setBusy] = useState<"" | "analyze" | "render">("");
  const [status, setStatus] = useState<string>("");
  const [detected, setDetected] = useState<Detected | null>(null);
  const [recipePath, setRecipePath] = useState<string>("");
  const [title, setTitle] = useState<string>("");

  const analyze = async () => {
    const id = vid.trim();
    if (!id) return;
    setBusy("analyze"); setStatus("Analyzing tutorial… (download + transcript, can take a minute)");
    setDetected(null); setRecipePath("");
    const r = await exec("teardown_analyze", { videoId: id });
    setBusy("");
    const d = (r.ok && (r.data as Record<string, unknown>)) || {};
    if (!r.ok || d.available === false) {
      setStatus(String((d as Record<string, unknown>).reason || "Teardown service unavailable — run service/teardown/setup-teardown.sh --with-video"));
      return;
    }
    setDetected((d.detected as Detected) || {});
    setRecipePath(String(d.recipe || ""));
    setTitle(String(d.title || ""));
    setStatus(`Analyzed — ${Number(d.elements || 0)} element(s) detected.`);
  };

  const reconstruct = async () => {
    if (!recipePath) return;
    setBusy("render"); setStatus("Rendering reconstruction…");
    const r = await exec("teardown_render", { recipePath });
    const d = (r.ok && (r.data as Record<string, unknown>)) || {};
    if (!r.ok || d.available === false) {
      setBusy(""); setStatus(String((d as Record<string, unknown>).reason || "Render unavailable (needs the local service + engine)"));
      return;
    }
    const wav = String(d.outWav || "");
    if (wav) {
      await exec("import_clip", { file: wav, trackId: selectedTrackId ?? undefined });
      const yld = (d.yield as Record<string, number>) || {};
      setStatus(`Reconstruction imported${selectedTrackId ? "" : " (new track)"} — yield ${yld.overall ?? "?"}, class ${d.reconstructionClass ?? "?"}.`);
    } else {
      setStatus("Render produced no audio.");
    }
    setBusy("");
  };

  return (
    <div className="v2-teardown" data-testid="v2-teardown-panel">
      <div className="v2-teardown-intro">Tear a tutorial down into a starting point.</div>
      <label className="v2-teardown-field">
        <span>Tutorial URL or video id</span>
        <input
          data-testid="v2-teardown-url"
          type="text" value={vid} placeholder="youtube url or id"
          onChange={(e) => setVid(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void analyze(); }}
        />
      </label>
      <button data-testid="v2-teardown-analyze" disabled={!vid.trim() || busy !== ""} onClick={() => void analyze()}>
        {busy === "analyze" ? "Analyzing…" : "Analyze"}
      </button>

      {detected && (
        <div className="v2-teardown-recipe" data-testid="v2-teardown-recipe">
          {title && <div className="v2-teardown-title">{title}</div>}
          <ul>
            <li>DAW: {detected.daw || "—"}</li>
            <li>Tempo: {detected.tempo ?? "—"}{detected.tempo ? " BPM" : ""}</li>
            <li>Key: {detected.key || "—"}</li>
            <li>Piano-roll: {detected.pianoroll ? "yes" : "no"}</li>
            <li>Plugins: {(detected.plugins && detected.plugins.length) ? detected.plugins.join(", ") : "—"}</li>
          </ul>
          <button data-testid="v2-teardown-reconstruct" disabled={!recipePath || busy !== ""} onClick={() => void reconstruct()}>
            {busy === "render" ? "Rendering…" : "Reconstruct → import"}
          </button>
        </div>
      )}

      {status && <div className="v2-teardown-status" data-testid="v2-teardown-status">{status}</div>}
    </div>
  );
}
