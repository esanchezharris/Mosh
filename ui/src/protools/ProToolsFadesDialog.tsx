import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import { applyProToolsFadePlan } from "./proToolsFadeApply";
import {
  currentProToolsDefaultFadeOptions,
  rememberProToolsDefaultFadeOptions,
} from "./proToolsFadeDefaults";
import {
  buildProToolsFadePlan,
  PROTOOLS_FADE_CURVES,
  proToolsFadePath,
  type ProToolsFadeCurve,
  type ProToolsFadeTarget,
} from "./proToolsFades";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
const CURVE_LABELS: Readonly<Record<ProToolsFadeCurve, string>> = {
  linear: "Linear",
  convex: "Convex",
  concave: "Concave",
  sCurve: "S-Curve",
};

export function ProToolsFadesDialog({ targets, onClose }: {
  readonly targets: readonly ProToolsFadeTarget[];
  readonly onClose: () => void;
}) {
  const projectEpoch = useStore((state) => state.projectEpoch);
  const dialogRef = useRef<HTMLElement>(null);
  const lengthRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openEpochRef = useRef(projectEpoch);
  const defaultsRef = useRef(currentProToolsDefaultFadeOptions());
  const [fadeIns, setFadeIns] = useState(true);
  const [fadeOuts, setFadeOuts] = useState(true);
  const [crossfades, setCrossfades] = useState(true);
  const [edgeLength, setEdgeLength] = useState(String(defaultsRef.current.edgeLengthMs));
  const [curveIn, setCurveIn] = useState<ProToolsFadeCurve>(defaultsRef.current.curveIn);
  const [curveOut, setCurveOut] = useState<ProToolsFadeCurve>(defaultsRef.current.curveOut);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedLength = Number(edgeLength);
  const lengthValid = Number.isFinite(parsedLength) && parsedLength >= 0 && parsedLength <= 60_000;
  const plan = useMemo(() => buildProToolsFadePlan(targets, {
    fadeIns,
    fadeOuts,
    crossfades,
    edgeLengthMs: lengthValid ? parsedLength : 0,
    curveIn,
    curveOut,
  }), [crossfades, curveIn, curveOut, fadeIns, fadeOuts, lengthValid, parsedLength, targets]);

  const dismiss = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  useEffect(() => pushEscapeHandler(dismiss), [dismiss]);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    lengthRef.current?.focus();
    lengthRef.current?.select();
    return () => restoreFocusRef.current?.focus();
  }, []);
  useEffect(() => {
    if (projectEpoch !== openEpochRef.current) onClose();
  }, [onClose, projectEpoch]);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lengthValid) {
      setError("Fade length must be between 0 and 60,000 milliseconds.");
      lengthRef.current?.focus();
      return;
    }
    if (plan.edits.length === 0) {
      setError("Choose at least one fade operation supported by the current selection.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await applyProToolsFadePlan("create fades", plan, openEpochRef.current);
    if (result.stale) {
      onClose();
      return;
    }
    if (result.error) {
      setSubmitting(false);
      setError(result.error);
      return;
    }
    rememberProToolsDefaultFadeOptions({
      fadeIns: true,
      fadeOuts: true,
      crossfades: true,
      edgeLengthMs: parsedLength,
      curveIn,
      curveOut,
    });
    onClose();
  };

  const title = targets.length > 1 ? "Batch Fades" : "Fades";
  return (
    <div className="pt-fades-backdrop" data-testid="pt-fades-backdrop" role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="pt-fades-dialog" data-testid="pt-fades-dialog"
        role="dialog" aria-modal="true" aria-labelledby="pt-fades-title"
        aria-describedby="pt-fades-description" tabIndex={-1}
        onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        <header className="pt-fades-head">
          <div><h2 id="pt-fades-title">{title}</h2><span>{targets.length} audio clip{targets.length === 1 ? "" : "s"}</span></div>
          <button type="button" data-testid="pt-fades-close" disabled={submitting} onClick={dismiss}>Close</button>
        </header>
        <form aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <p id="pt-fades-description">
            Apply persisted edge fades and curve-shaped crossfades through the current overlap.
          </p>
          <fieldset className="pt-fades-options">
            <legend>Create</legend>
            <label><input type="checkbox" data-testid="pt-fades-in" checked={fadeIns} disabled={submitting}
              onChange={(event) => setFadeIns(event.currentTarget.checked)} /> Fade-In</label>
            <label><input type="checkbox" data-testid="pt-fades-crossfade" checked={crossfades} disabled={submitting}
              onChange={(event) => setCrossfades(event.currentTarget.checked)} /> Crossfades</label>
            <label><input type="checkbox" data-testid="pt-fades-out" checked={fadeOuts} disabled={submitting}
              onChange={(event) => setFadeOuts(event.currentTarget.checked)} /> Fade-Out</label>
          </fieldset>
          <div className="pt-fades-grid">
            <label htmlFor="pt-fades-length">Edge length</label>
            <span className="pt-fades-length-field">
              <input ref={lengthRef} id="pt-fades-length" data-testid="pt-fades-length"
                type="number" min="0" max="60000" step="1" inputMode="decimal"
                value={edgeLength} disabled={submitting || (!fadeIns && !fadeOuts)}
                aria-invalid={!lengthValid} aria-describedby={!lengthValid ? "pt-fades-error" : undefined}
                onChange={(event) => { setEdgeLength(event.currentTarget.value); setError(null); }} />
              <span>ms</span>
            </span>
            <label htmlFor="pt-fades-curve-in">Fade-In shape</label>
            <select id="pt-fades-curve-in" data-testid="pt-fades-curve-in" value={curveIn} disabled={submitting}
              onChange={(event) => setCurveIn(curveFrom(event.currentTarget.value))}>
              {PROTOOLS_FADE_CURVES.map((curve) => <option key={curve} value={curve}>{CURVE_LABELS[curve]}</option>)}
            </select>
            <label htmlFor="pt-fades-curve-out">Fade-Out shape</label>
            <select id="pt-fades-curve-out" data-testid="pt-fades-curve-out" value={curveOut} disabled={submitting}
              onChange={(event) => setCurveOut(curveFrom(event.currentTarget.value))}>
              {PROTOOLS_FADE_CURVES.map((curve) => <option key={curve} value={curve}>{CURVE_LABELS[curve]}</option>)}
            </select>
          </div>
          <div className="pt-fades-preview" aria-label={`${CURVE_LABELS[curveIn]} in and ${CURVE_LABELS[curveOut]} out preview`}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path className="in" d={proToolsFadePath(curveIn, "in")} />
              <path className="out" d={proToolsFadePath(curveOut, "out")} />
            </svg>
          </div>
          <div className="pt-fades-summary" role="status">
            <div>{plan.crossfades.length > 0
              ? `${plan.crossfades.length} existing overlap${plan.crossfades.length === 1 ? "" : "s"} · exact overlap length`
              : "No selected audio overlap · edge fades only"}
              <span data-testid="pt-fades-default-summary">
                After Apply: ⌘⌃F uses {lengthValid ? `${parsedLength} ms` : "a valid length"}, {CURVE_LABELS[curveIn]} / {CURVE_LABELS[curveOut]}
              </span>
            </div>
            <span>Placement outside existing overlap and audition are not available.</span>
          </div>
          {error && <p id="pt-fades-error" className="pt-fades-error" data-testid="pt-fades-error" role="alert">{error}</p>}
          <div className="pt-fades-actions">
            <button type="button" disabled={submitting} onClick={dismiss}>Cancel</button>
            <button type="submit" data-testid="pt-fades-apply" disabled={submitting || plan.edits.length === 0}>
              {submitting ? "Applying…" : "Apply"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function curveFrom(value: string): ProToolsFadeCurve {
  return PROTOOLS_FADE_CURVES.find((curve) => curve === value) ?? "linear";
}
