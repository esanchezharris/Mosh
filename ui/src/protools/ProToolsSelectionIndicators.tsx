import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { useShell, type TimeRangeSel } from "../v2/shellState";
import { timelineSeconds } from "./layout";
import { useProTools } from "./proToolsState";
import {
  formatSelectionDuration,
  parseSelectionDuration,
  selectionIndicatorDrafts,
  type SelectionIndicatorDrafts,
} from "./selectionIndicators";
import {
  parseSpotTime,
  SPOT_TIME_SCALES,
} from "./spotTime";

type SelectionField = "start" | "end" | "length";

const LABELS: Readonly<Record<SelectionField, string>> = {
  start: "Start",
  end: "End",
  length: "Length",
};

export function ProToolsSelectionIndicators({ snapshot }: { readonly snapshot: Snapshot }) {
  const range = useShell((state) => state.timeRange);
  const setRange = useShell((state) => state.setTimeRange);
  const setDragging = useShell((state) => state.setTimeRangeDragging);
  const position = useStore((state) => state.transport.position);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const scale = useProTools((state) => state.mainTimeScale);
  const setScale = useProTools((state) => state.setMainTimeScale);
  const totalSeconds = timelineSeconds(snapshot);
  const rootRef = useRef<HTMLElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  const lengthRef = useRef<HTMLInputElement>(null);
  const epochRef = useRef(projectEpoch);
  const displayed = useMemo(
    () => selectionIndicatorDrafts({ range, position, scale, snapshot }),
    [position, range, scale, snapshot],
  );
  const [drafts, setDrafts] = useState<SelectionIndicatorDrafts>(displayed);
  const [activeField, setActiveField] = useState<SelectionField | null>(null);
  const [invalidField, setInvalidField] = useState<SelectionField | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelDraft = useCallback((blur: boolean): void => {
    setDrafts(displayed);
    setActiveField(null);
    setInvalidField(null);
    setError(null);
    const activeElement = document.activeElement;
    if (blur && activeElement instanceof HTMLElement && rootRef.current?.contains(activeElement))
      activeElement.blur();
  }, [displayed]);

  useEffect(() => {
    if (activeField === null) setDrafts(displayed);
  }, [activeField, displayed]);

  useEffect(() => {
    if (epochRef.current === projectEpoch) return;
    epochRef.current = projectEpoch;
    cancelDraft(true);
  }, [cancelDraft, projectEpoch]);

  const reject = (field: SelectionField, message: string): false => {
    setInvalidField(field);
    setError(message);
    return false;
  };

  const parsedRange = (field: SelectionField): TimeRangeSel | null => {
    const start = parseSpotTime(drafts.start, scale, snapshot);
    if (!start.ok) {
      reject("start", start.error);
      return null;
    }
    let endSeconds: number;
    if (field === "length") {
      const length = parseSelectionDuration({
        value: drafts.length,
        start: start.seconds,
        scale,
        snapshot,
      });
      if (!length.ok) {
        reject("length", length.error);
        return null;
      }
      endSeconds = start.seconds + length.seconds;
    } else {
      const end = parseSpotTime(drafts.end, scale, snapshot);
      if (!end.ok) {
        reject("end", end.error);
        return null;
      }
      endSeconds = end.seconds;
    }
    if (endSeconds <= start.seconds) {
      reject(field === "start" ? "start" : "end", "End must be after Start.");
      return null;
    }
    if (endSeconds > totalSeconds + 1e-6) {
      reject(field, "Selection must stay inside the visible session timeline.");
      return null;
    }
    return { start: start.seconds, end: endSeconds };
  };

  const accept = (field: SelectionField): boolean => {
    const next = parsedRange(field);
    if (!next) return false;
    setRange(next);
    setDragging(false);
    setDrafts(selectionIndicatorDrafts({ range: next, position, scale, snapshot }));
    setActiveField(null);
    setInvalidField(null);
    setError(null);
    return true;
  };

  const focusField = (field: SelectionField): void => {
    const ref = field === "start" ? startRef : field === "end" ? endRef : lengthRef;
    ref.current?.focus();
    ref.current?.select();
  };

  const advance = (field: SelectionField): void => {
    const start = parseSpotTime(drafts.start, scale, snapshot);
    if (!start.ok) {
      reject("start", start.error);
      return;
    }
    if (field === "start") {
      focusField("end");
      return;
    }
    if (field === "end") {
      const end = parseSpotTime(drafts.end, scale, snapshot);
      if (!end.ok) {
        reject("end", end.error);
        return;
      }
      if (end.seconds <= start.seconds) {
        reject("end", "End must be after Start.");
        return;
      }
      setDrafts((current) => ({
        ...current,
        length: formatSelectionDuration({
          seconds: end.seconds - start.seconds,
          start: start.seconds,
          scale,
          snapshot,
        }),
      }));
      focusField("length");
      return;
    }
    focusField("start");
  };

  const onKeyDown = (field: SelectionField, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelDraft(true);
      return;
    }
    const slash = (event.code === "Slash" || event.code === "NumpadDivide")
      && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (slash) {
      event.preventDefault();
      event.stopPropagation();
      advance(field);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    accept(field);
  };

  const onBlur = (event: FocusEvent<HTMLElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
    cancelDraft(false);
  };

  const changeScale = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = SPOT_TIME_SCALES.find((candidate) => candidate.id === event.currentTarget.value)?.id;
    if (!next) return;
    cancelDraft(false);
    setScale(next);
  };

  return (
    <section ref={rootRef} className="pt-toolbar-group pt-selection-indicators"
      role="group" aria-label="Edit Selection indicators" onBlur={onBlur}>
      <label className="pt-selection-heading">
        <span>Edit Selection</span>
        <select aria-label="Main time scale" value={scale} onChange={changeScale}>
          {SPOT_TIME_SCALES.map((option) => (
            <option value={option.id} key={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
      <div className="pt-selection-grid">
        {(Object.keys(LABELS) as SelectionField[]).map((field) => (
          <label className="pt-selection-field" key={field}>
            <span>{LABELS[field]}</span>
            <input ref={field === "start" ? startRef : field === "end" ? endRef : lengthRef}
              id={`pt-selection-${field}`}
              data-testid={`pt-selection-${field}`}
              aria-label={`Edit Selection ${LABELS[field]}`}
              aria-invalid={invalidField === field}
              aria-describedby={invalidField === field ? "pt-selection-error" : undefined}
              aria-keyshortcuts="/ Enter Escape"
              inputMode="numeric" autoComplete="off" spellCheck={false}
              value={drafts[field]}
              onFocus={(event) => { setActiveField(field); event.currentTarget.select(); }}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDrafts((current) => ({ ...current, [field]: value }));
                setInvalidField(null);
                setError(null);
              }}
              onKeyDown={(event) => onKeyDown(field, event)} />
          </label>
        ))}
        {error && <span id="pt-selection-error" className="pt-selection-error" role="alert">{error}</span>}
      </div>
    </section>
  );
}
