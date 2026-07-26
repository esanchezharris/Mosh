// UI-REACH — sketch_beatbox's entry point. cmdSketchBeatbox (MoshOps.cpp) takes an
// ABSOLUTE PATH, not a clipId, so the clip context menu (transcribe_clip/
// build_skeleton_from_clip's home) is not a drop-in fit — a real path only exists at a
// file-chooser. SampleBrowser's directory listing already IS the record/import flow's
// file-chooser, and (unlike pickFiles' native dialog) `list_directory` is answered
// identically by the real backend, the dev mock, and Playwright — so this dialog only
// ever needs a `file` prop the caller already resolved, never pickFiles itself.
//
// bpm/bars are validated CLIENT-SIDE against the exact bounds cmdSketchBeatbox enforces
// (20–300 BPM; bars clamped 1–2 — modelled here as a two-way toggle rather than a second
// numeric field, since there is no third option) so the engine's own rejection never has
// to surface as an error toast. wait:false — the alternative blocks the message thread
// (WebBridge.cpp's execute_command is synchronous; see cmdSketchBeatbox's own comment).
// The command is install-gated with no graceful degradation (server.py's /sketch 503s
// "sketch_unavailable (run service/sketch/setup-sketch.sh)" when the venv is absent);
// that honest message rides the sketch_status event straight to the shared lastError
// toast (store.ts) exactly like transcribe_status/skeleton_status's errors do.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

const MIN_BPM = 20;
const MAX_BPM = 300;

const baseName = (p: string) => p.split("/").pop() ?? p;

export function sketchBpmValid(raw: string): boolean {
  if (raw.trim() === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_BPM && n <= MAX_BPM;
}

export function SketchBeatboxDialog({ file, onClose }: { file: string; onClose: () => void }) {
  const exec = useStore((s) => s.exec);
  const sessionTempo = useStore((s) => s.snapshot?.session.tempo);
  // Default to the project's own tempo — the likeliest correct value, since a beatbox is
  // usually boxed to the song already open (still fully editable; not a silent guess).
  const [bpm, setBpm] = useState<string>(() => String(Math.round(sessionTempo ?? 120)));
  const [bars, setBars] = useState<1 | 2>(1);
  useEscapeToClose(true, onClose);

  const valid = sketchBpmValid(bpm);

  const confirm = () => {
    if (!valid) return;
    void exec("sketch_beatbox", { file, bpm: Number(bpm), bars, wait: false });
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} data-testid="sketch-beatbox-backdrop">
      <div
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Beatbox to beat"
        data-testid="sketch-beatbox-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong className="display">Beatbox → beat</strong>
          <button type="button" className="btn x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="confirm-body pop-note">
          Turn “{baseName(file)}” into an editable drum clip. It was recorded to a click —
          tell Mosh that tempo so the hits land on the grid.
        </div>
        <label className="pop-row">
          <span>Tempo (BPM)</span>
          <input
            type="number"
            min={MIN_BPM}
            max={MAX_BPM}
            autoFocus
            value={bpm}
            data-testid="sketch-bpm-input"
            aria-invalid={!valid}
            onChange={(e) => setBpm(e.target.value)}
          />
        </label>
        {!valid && (
          <div className="pop-note" data-testid="sketch-bpm-hint" role="alert">
            BPM must be between {MIN_BPM} and {MAX_BPM}.
          </div>
        )}
        <div className="pop-row" role="group" aria-label="Loop length">
          <span>Loop length</span>
          <button type="button" className="btn" aria-pressed={bars === 1} data-testid="sketch-bars-1" onClick={() => setBars(1)}>1 bar</button>
          <button type="button" className="btn" aria-pressed={bars === 2} data-testid="sketch-bars-2" onClick={() => setBars(2)}>2 bars</button>
        </div>
        <div className="pop-actions confirm-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!valid}
            data-testid="sketch-beatbox-confirm"
            onClick={confirm}
          >
            Sketch it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
