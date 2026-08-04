// REC-001 — what a live MIDI take DOES, and Ableton's Capture MIDI.
//
// Five settings behind one chip rather than five more chips in the top bar: the bar
// already carries key, tempo, time signature, metronome, count-in and snap, and these are
// things you set once for a session and then forget. The chip sits next to Count-in
// deliberately — that is the other "what happens when I hit record" control, and a
// producer looking for one will find the other.
//
// Capture is a BUTTON, not a setting, so it lives in the transport next to Record where
// Ableton puts it. It is the one control here a producer presses in a hurry.

import { useStore } from "../store";
import { useAnchoredPanel } from "../hooks/useAnchoredPanel";
import { runCaptureMidi } from "../captureMidi";
import type { RecordOptions } from "../types";

/** The grids tracktion actually implements, as beats. Mirrors kQuantGrids in
 *  MoshOps.Record.cpp — deliberately irregular (1/9 and 1/12 exist, 1/48 does not).
 *  Offered as a closed list precisely because the backend REFUSES anything off it
 *  rather than snapping to the nearest: a free-text field here would let a producer
 *  type 1/48 and get an error instead of a grid. */
const QUANT_GRIDS: { beats: number; label: string }[] = [
  { beats: 0, label: "Off" },
  { beats: 1 / 4, label: "1/16 note" },
  { beats: 1 / 3, label: "1/8 triplet" },
  { beats: 1 / 2, label: "1/8 note" },
  { beats: 1, label: "1/4 note" },
];

const DEFAULTS: RecordOptions = {
  overdub: true, replaceExisting: false, quantize: 0,
  quantizeLabel: "(none)", punchInOut: false, retrospectiveSeconds: 10,
};

/** The take-behaviour chip + its panel. */
export function RecordOptionsChip() {
  const exec = useStore((s) => s.exec);
  const opts = useStore((s) => s.snapshot?.session.project?.recordOptions) ?? DEFAULTS;
  // 320 MUST match `.v2-rec-panel { width }` in css/20-topbar.css — the hook clamps the
  // panel into the viewport using this number, so a disagreement mis-places it on a
  // narrow window. RecordPanel.test.ts pins the two together.
  const { open, at, anchorRef, panelRef, toggle } = useAnchoredPanel(320, 320, "start");

  const set = (patch: Partial<RecordOptions>) => void exec("set_record_options", patch);

  // The chip surfaces only what would SURPRISE you. Overdub on, no quantise, no punch is
  // the default and the expectation, so the chip is just "Rec" — spelling out the default
  // state would be three words of noise on a bar that already carries six controls.
  // Anything that would make the next take behave unexpectedly gets named. (It also has
  // to stay one line: the first version rendered "Rec: overdub" wrapped, and a 41px chip
  // in a row of 24px ones knocked the whole bar out of alignment.)
  const flags = [
    opts.overdub ? null : "new take",
    opts.quantize > 0 ? "grid" : null,
    opts.punchInOut ? "punch" : null,
  ].filter(Boolean);
  const label = flags.length ? `Rec: ${flags.join(" · ")}` : "Rec";

  // The full state lives in the tooltip, so nothing is hidden — just not shouted.
  const title = `Recording: ${opts.overdub ? "overdub" : "new take each time"}`
    + `, quantise ${opts.quantize > 0 ? opts.quantizeLabel : "off"}`
    + `, punch ${opts.punchInOut ? "on" : "off"}`;

  return (
    <span className="v2-menu-wrap">
      <button ref={anchorRef} className="v2-chip v2-rec-chip" data-testid="v2-rec-opts"
        aria-label="Recording options" aria-haspopup="dialog" aria-expanded={open}
        title={title}
        onClick={toggle}>{label}</button>
      {open && at && (
        <div ref={panelRef} className="v2-menu-panel v2-menu-panel-fixed v2-rec-panel"
          style={{ left: at.left, top: at.top, bottom: at.bottom }}
          role="dialog" aria-label="Recording options" data-testid="v2-rec-panel">

          <label className="v2-rec-row">
            <input type="checkbox" data-testid="v2-rec-overdub" checked={opts.overdub}
              onChange={(e) => set({ overdub: e.target.checked })} />
            <span>
              <b>Overdub</b>
              <em>A new take merges into the clip it lands on instead of starting a fresh one.</em>
            </span>
          </label>

          <label className="v2-rec-row">
            <input type="checkbox" data-testid="v2-rec-replace" checked={opts.replaceExisting}
              onChange={(e) => set({ replaceExisting: e.target.checked })} />
            <span>
              <b>Replace what it covers</b>
              {/* Named honestly: the engine's replace path deletes the region WITHOUT the
                  undo manager, so this really is destructive. Capture ignores it entirely
                  (see cmdCaptureMidi) — only an actual recording can reach it. */}
              <em>A take deletes clips it overlaps. Undo will not bring them back.</em>
            </span>
          </label>

          <label className="v2-rec-row">
            <span><b>Quantise while recording</b></span>
            <select data-testid="v2-rec-quant" value={opts.quantize}
              onChange={(e) => set({ quantize: Number(e.target.value) })}>
              {QUANT_GRIDS.map((g) => <option key={g.label} value={g.beats}>{g.label}</option>)}
            </select>
          </label>

          <label className="v2-rec-row">
            <input type="checkbox" data-testid="v2-rec-punch" checked={opts.punchInOut}
              onChange={(e) => set({ punchInOut: e.target.checked })} />
            <span>
              <b>Punch</b>
              <em>Capture only inside the loop range.</em>
            </span>
          </label>

          <label className="v2-rec-row">
            <span><b>Capture reaches back</b></span>
            <span className="v2-rec-retro">
              <input type="range" data-testid="v2-rec-retro" min={0} max={60} step={5}
                value={opts.retrospectiveSeconds}
                onChange={(e) => set({ retrospectiveSeconds: Number(e.target.value) })} />
              <span className="tc">{opts.retrospectiveSeconds}s</span>
            </span>
          </label>
        </div>
      )}
    </span>
  );
}

/** Capture MIDI — keep what you just played but did not record. */
export function CaptureButton() {
  const exec = useStore((s) => s.exec);

  // The outcome handling lives in runCaptureMidi because ⇧⌘C is the other front door;
  // both land on the shared banner the recording lifecycle already uses.
  const capture = async () => {
    const { message } = await runCaptureMidi(exec);
    useStore.setState({ lastError: message });
  };

  return (
    <button className="v2-tbtn v2-capture" data-testid="v2-capture"
      title="Capture MIDI — keep what you just played, even though you were not recording (⇧⌘C)"
      aria-label="Capture MIDI"
      onClick={() => void capture()}>⤓</button>
  );
}
