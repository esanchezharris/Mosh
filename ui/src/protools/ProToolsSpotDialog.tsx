import { useCallback, useEffect, useRef, useState } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import type { Clip, Snapshot } from "../types";
import { formatSpotTime, parseSpotTime, SPOT_TIME_SCALES, type SpotTimeScale } from "./spotTime";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

type Props = {
  readonly clip: Clip;
  readonly snapshot: Snapshot;
  readonly onClose: () => void;
};

export function ProToolsSpotDialog({ clip, snapshot, onClose }: Props) {
  const exec = useStore((state) => state.exec);
  const dialogRef = useRef<HTMLElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openEpoch = useRef(useStore.getState().projectEpoch);
  const [scale, setScale] = useState<SpotTimeScale>("minutesSeconds");
  const [start, setStart] = useState(formatSpotTime(clip.start, scale, snapshot));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dismiss = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  useEffect(() => pushEscapeHandler(dismiss), [dismiss]);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    startRef.current?.focus();
    startRef.current?.select();
    return () => restoreFocusRef.current?.focus();
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((control) => !control.hasAttribute("hidden"));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseSpotTime(start, scale, snapshot);
    if (!parsed.ok) {
      setError(parsed.error);
      startRef.current?.focus();
      return;
    }
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await exec("move_clip", { clipId: clip.id, start: parsed.seconds });
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error ?? "The clip could not be spotted to that location.");
      startRef.current?.focus();
      return;
    }
    onClose();
  };

  return (
    <div className="pt-spot-backdrop" data-testid="pt-spot-backdrop" role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="pt-spot-dialog" data-testid="pt-spot-dialog"
        role="dialog" aria-modal="true" aria-labelledby="pt-spot-title"
        aria-describedby="pt-spot-description" tabIndex={-1}
        onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        <header className="pt-spot-head">
          <h2 id="pt-spot-title">Spot</h2>
          <span>{clip.name}</span>
        </header>
        <form aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <p id="pt-spot-description">Move the clip start to a precise timeline location.</p>
          <label htmlFor="pt-spot-start">Start</label>
          <input ref={startRef} id="pt-spot-start" data-testid="pt-spot-start"
            value={start} aria-invalid={error !== null}
            aria-describedby={error ? "pt-spot-error" : "pt-spot-description"}
            autoComplete="off" spellCheck={false} disabled={submitting}
            onChange={(event) => { setStart(event.currentTarget.value); setError(null); }} />
          <label htmlFor="pt-spot-scale">Time Scale</label>
          <select id="pt-spot-scale" value={scale} disabled={submitting} onChange={(event) => {
            const next = SPOT_TIME_SCALES.find((option) => option.id === event.currentTarget.value)?.id;
            if (!next) return;
            const parsed = parseSpotTime(start, scale, snapshot);
            setScale(next);
            setStart(formatSpotTime(parsed.ok ? parsed.seconds : clip.start, next, snapshot));
            setError(null);
          }}>
            {SPOT_TIME_SCALES.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <span className="pt-spot-rate">{snapshot.session.sampleRate.toLocaleString("en-US")} Hz</span>
          {error && <p id="pt-spot-error" className="pt-spot-error" role="alert">{error}</p>}
          <div className="pt-spot-actions">
            <button type="button" data-testid="pt-spot-cancel" disabled={submitting} onClick={dismiss}>Cancel</button>
            <button type="submit" disabled={submitting}>{submitting ? "Spotting…" : "Spot"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
