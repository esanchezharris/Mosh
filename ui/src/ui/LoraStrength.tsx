// One LoRA's strength, the same everywhere a LoRA is applied (Re-Imagine in V3 and
// Pro Tools, the v2 render rack, the LoRA Lab's kept stack). Before this each surface
// had its own default and range (70 / 0-100, 100 / 0-150, 0 / 0-150), so what a
// producer heard in one place was not what another applied.
//
// The owner's spec: a LoRA is added at 70; the slider runs 0-200 with a notch at 100
// marked "ideal"; the number can be clicked and any value typed. A typed value beyond
// the slider keeps its value and the slider pins to its nearest edge.

import { useEffect, useRef, useState } from "react";
import "./loraStrength.css";
import { formatStrength, LORA_IDEAL_VALUE, LORA_SLIDER_MAX, parseStrength, sliderPosition } from "./loraStrengthValues";

export { formatStrength, LORA_ADD_VALUE, LORA_IDEAL_VALUE, LORA_SLIDER_MAX, parseStrength, sliderPosition } from "./loraStrengthValues";

export function LoraStrength({ label, value, onChange, disabled, testId }: {
  /** The adapter's display name; the controls are named "<label> strength". */
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
  }, [editing]);
  const commit = () => {
    const parsed = parseStrength(draft);
    setEditing(false);
    if (parsed !== null && parsed !== value) onChange(parsed);
  };
  const shown = formatStrength(value);
  return (
    <span className="lora-strength" data-testid={testId}>
      <span className="lora-strength-track">
        <input type="range" min={0} max={LORA_SLIDER_MAX} step={1} value={sliderPosition(value)}
          disabled={disabled} aria-label={`${label} strength`} aria-valuetext={shown}
          onChange={(event) => onChange(Number(event.target.value))} />
        <span className="lora-strength-notch" aria-hidden="true" title={`${LORA_IDEAL_VALUE}: ideal`}>
          <span className="lora-strength-ideal">ideal</span>
        </span>
      </span>
      {editing
        ? <input ref={input} className="lora-strength-input" type="text" inputMode="decimal" value={draft}
            data-owns-edit-keys="" aria-label={`${label} strength value`}
            onChange={(event) => setDraft(event.target.value)} onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commit(); }
              else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
            }} />
        : <button type="button" className="lora-strength-num" disabled={disabled}
            title="Click to type any value" aria-label={`${label} strength ${shown}, type a value`}
            onClick={() => { setDraft(shown); setEditing(true); }}>{shown}</button>}
    </span>
  );
}
