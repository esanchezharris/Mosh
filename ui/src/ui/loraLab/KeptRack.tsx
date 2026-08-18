// The adapters you kept — and what they sound like TOGETHER.
//
// Keeping one take is a decision; stacking two is the next question a producer
// asks, and it is not answerable from the individual takes. Adapters merge
// sequentially into the DiT, so a stack is not a mix of two sounds — it is a
// third sound, and the only way to know it is to render it.
//
// Two consequences shape this component:
//
//   * ORDER is a parameter, not presentation. The rack lists entries in merge
//     order and appends new ones at the end rather than sorting alphabetically,
//     because re-sorting under the producer's hand would silently change what
//     they are hearing.
//   * There is NO cap and no clamp. That is the standing owner call for the LoRA
//     rack (registry.py's "NO budget rule"): >100 is deliberate overdrive,
//     0 removes. The Sigma readout below is informational — it tells you how hard
//     you are pushing, it does not stop you.
//
// Deliberately shows only `family === "library"`. A run's six checkpoints are
// candidates, not kept things; letting them fill this list would bury the three
// adapters the producer actually chose under thirty they discarded.

import { useState } from "react";
import { useStore } from "../../store";
import { stackKey } from "../../store/loraLab";

export function KeptRack() {
  const loras = useStore((s) => s.availableLoras);
  const stack = useStore((s) => s.labStack);
  const setValue = useStore((s) => s.setLabStackValue);
  const audition = useStore((s) => s.auditionLabStack);
  const stop = useStore((s) => s.stopLabAudition);
  const cued = useStore((s) => s.labCued);
  const renders = useStore((s) => s.labRenders);
  const promptSet = useStore((s) => s.labPrompt.trim().length > 0);
  const [openRack, setOpenRack] = useState(false);

  // Only kept adapters. `valid` too: an unreadable file is listed by the registry
  // with a reason rather than hidden, but stacking one would just fail at render.
  const kept = loras.filter((l) => l.family !== "lab" && l.valid);
  if (kept.length === 0) return null;

  const key = stackKey(stack);
  const render = renders[key];
  const playing = cued === key && render?.status === "ready";
  const total = stack.reduce((n, e) => n + e.value, 0);
  const valueOf = (name: string) => stack.find((e) => e.name === name)?.value ?? 0;

  return (
    <section className="lab-kept" data-testid="lab-kept">
      <div className="lab-kept-head">
        <button
          className="btn ghost lab-kept-toggle"
          aria-expanded={openRack}
          onClick={() => setOpenRack(!openRack)}
        >
          {openRack ? "▾" : "▸"} Kept <span className="lab-kept-n">{kept.length}</span>
        </button>

        {stack.length > 0 && (
          <>
            <button
              className={`btn lab-play${playing ? " on" : ""}`}
              data-testid="lab-stack-play"
              disabled={!promptSet}
              title={!promptSet
                ? "Write a prompt first — a stack needs something to render"
                : playing ? "Stop" : "Audition this stack"}
              aria-label={playing ? "Stop the stack" : "Audition the stack"}
              onClick={() => (playing ? stop() : void audition())}
            >{render?.status === "rendering" ? "◌" : playing ? "■" : "▶"}</button>
            {/* Informational only — see the header note. */}
            <span className="lab-kept-sum" data-testid="lab-stack-sum"
              title="Total strength across the stack. Not a limit — over 100 is deliberate overdrive.">
              Σ {total}
            </span>
          </>
        )}
      </div>

      {render?.status === "error" && (
        <div className="lab-take-note err" data-testid="lab-stack-error">{render.error}</div>
      )}

      {openRack && (
        <div className="lab-kept-list">
          {kept.map((l) => {
            const v = valueOf(l.name);
            return (
              <div className={`nparam lab-kept-row${v > 0 ? " on" : ""}`} key={l.name}>
                <span className="nlabel" title={l.hint || l.name}>{l.displayName || l.name}</span>
                <input
                  type="range"
                  min={0}
                  max={150}
                  step={5}
                  value={v}
                  aria-label={`${l.displayName || l.name} strength`}
                  data-testid={`lab-kept-slider-${l.name}`}
                  onChange={(e) => setValue(l.name, Number(e.target.value))}
                />
                <span className="nval">{v || "–"}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
