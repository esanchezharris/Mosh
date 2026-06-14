// The permanent Moshi stage — a right rail where the character lives large enough for
// his reactive body to read, with a live spectrum readout, a state-tinted ambient glow,
// a one-word MOOD (his read on the work), and a voice mute. He stays in his rail (per the
// reskin decision); the promotion is presence + legibility, not a layout move.

import type { CSSProperties } from "react";
import { Moshi } from "./Moshi";
import { useStore } from "../store";

// state → a one-word mood + the tint that washes the rail and dot.
const MOOD: Record<string, { word: string; tint: string }> = {
  recording: { word: "hot", tint: "#ff3b5c" },
  rendering: { word: "cooking", tint: "#ff9b3b" },
  listening: { word: "vibing", tint: "var(--lime)" },
  idle: { word: "resting", tint: "var(--lime-dim)" },
};

export function MoshiStage() {
  const bands = useStore((s) => s.spectrum.bands);
  const playing = useStore((s) => s.snapshot?.transport.playing ?? false);
  const recording = useStore((s) => s.snapshot?.transport.recording ?? false);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const muted = useStore((s) => s.moshiMuted);
  const toggleMute = useStore((s) => s.toggleMoshiMute);

  const state = recording ? "recording" : rendering ? "rendering" : playing ? "listening" : "idle";
  const mood = MOOD[state];
  const shown = bands.length ? bands : Array(8).fill(0);

  return (
    <aside className="moshi-stage" data-testid="moshi-stage" data-state={state}
      style={{ "--moshi-tint": mood.tint } as CSSProperties}>
      <button className="stage-mute" title={muted ? "Unmute Moshi's voice" : "Mute Moshi's voice"}
        aria-pressed={!muted} onClick={toggleMute}>{muted ? "🔇" : "🔊"}</button>
      <div className="stage-canvas"><Moshi /></div>
      <div className="stage-spectrum" data-testid="stage-spectrum" aria-hidden="true">
        {shown.map((b, i) => (
          <span key={i} className="sbar" style={{ height: `${Math.max(3, Math.round(b * 100))}%` }} />
        ))}
      </div>
      <div className="stage-mood display" data-state={state} data-testid="moshi-mood">
        <i className="mood-dot" aria-hidden="true" /> {mood.word}
      </div>
    </aside>
  );
}
