import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { beatAt, tempoMapFrom } from "../time";
import { useStore } from "../store";
import type { Annotation, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { formatSpotTime } from "./spotTime";
import {
  captureMemoryLocationProperties,
  filterMemoryLocations,
  memoryLocationRecallProperties,
  numberedMemoryLocations,
  type NumberedMemoryLocation,
} from "./memoryLocations";
import { useProTools, type ProToolsMemoryLocationEditor } from "./proToolsState";
import { proToolsEditTracks, proToolsShownTracks } from "./proToolsTrackVisibility";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
const COLORS = [
  { value: "", label: "No color" },
  { value: "#4a90d9", label: "Blue" },
  { value: "#d9904a", label: "Orange" },
  { value: "#77a867", label: "Green" },
  { value: "#9868d8", label: "Purple" },
] as const;

export function ProToolsMemoryLocations({ snapshot }: { readonly snapshot: Snapshot }) {
  const exec = useStore((state) => state.exec);
  const setLastError = useStore((state) => state.setLastError);
  const open = useProTools((state) => state.memoryLocationsOpen);
  const editor = useProTools((state) => state.memoryLocationEditor);
  const setOpen = useProTools((state) => state.setMemoryLocationsOpen);
  const requestNew = useProTools((state) => state.requestNewMemoryLocation);
  const requestEdit = useProTools((state) => state.requestEditMemoryLocation);
  const closeEditor = useProTools((state) => state.closeMemoryLocationEditor);
  const [query, setQuery] = useState("");
  const locations = useMemo(() => numberedMemoryLocations(snapshot), [snapshot]);
  const filtered = useMemo(() => filterMemoryLocations(locations, query), [locations, query]);

  useEffect(() => {
    if (!open || editor) return;
    return pushEscapeHandler(() => setOpen(false));
  }, [editor, open, setOpen]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const run = async (command: string, args: Record<string, unknown>, fallback: string) => {
    const result = await exec(command, args);
    if (!result.ok) setLastError(result.error ?? fallback);
    return result.ok;
  };
  const seek = async (location: NumberedMemoryLocation) => {
    const epoch = useStore.getState().projectEpoch;
    const recalled = memoryLocationRecallProperties(
      location.annotation.memoryLocation,
      proToolsEditTracks(snapshot.tracks).map((track) => track.id),
    );
    const ok = await run(
      "set_transport",
      { position: location.seconds },
      "The Memory Location could not be recalled.",
    );
    if (!ok || useStore.getState().projectEpoch !== epoch || !recalled) return;

    const trackIds = proToolsEditTracks(snapshot.tracks).map((track) => track.id);
    if (recalled.editSelection) {
      const selection = {
        start: recalled.editSelection.start,
        end: recalled.editSelection.end,
      };
      const selectionTrackIds = recalled.editSelection.trackIds ?? trackIds;
      useShell.getState().setTimeRange(selection);
      useShell.getState().setTimeRangeDragging(false);
      useProTools.getState().setEditSelectionTracks(
        selectionTrackIds,
        selectionTrackIds[0] ?? null,
      );
    }
    if (recalled.horizontalZoom !== undefined) {
      useStore.getState().setPxPerSec(recalled.horizontalZoom);
    }
    if (recalled.shownTrackIds) {
      useProTools.getState().setShownTrackIds(trackIds, recalled.shownTrackIds);
    }
  };
  const remove = (annotation: Annotation) => run(
    "remove_annotation",
    { annotationId: annotation.id },
    `Could not remove ${annotation.text}.`,
  );

  if (!open && !editor) return null;
  return (
    <>
      {open && (
        <section id="pt-memory-locations" className="pt-memory-window"
          data-testid="pt-memory-locations" aria-label="Memory Locations">
          <header className="pt-memory-head">
            <div><h2>Memory Locations</h2><span>{locations.length} markers</span></div>
            <button type="button" data-testid="pt-memory-add"
              onClick={() => requestNew(useStore.getState().transport.position)}>Add</button>
            <button type="button" data-testid="pt-memory-close" onClick={() => setOpen(false)}>Close</button>
          </header>
          <label className="pt-memory-search-label">
            <span>Filter</span>
            <input type="search" data-testid="pt-memory-search" value={query}
              placeholder="Name or number" onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <div className="pt-memory-columns" aria-hidden="true">
            <span>#</span><span>Name</span><span>Time</span><span>Clr</span><span>Actions</span>
          </div>
          <ol className="pt-memory-list" aria-label="Marker Memory Locations">
            {filtered.map((location) => (
              <li key={location.annotation.id} data-memory-location-number={location.number}>
                <span className="pt-memory-number">{location.number}</span>
                <button type="button" className="pt-memory-recall"
                  data-testid={`pt-memory-recall-${location.annotation.id}`}
                  title="Recall location; Option-click removes it"
                  onDoubleClick={() => requestEdit(location.annotation.id)}
                  onClick={(event) => {
                    if (event.altKey) {
                      void remove(location.annotation);
                      return;
                    }
                    void seek(location);
                  }}>
                  {location.annotation.text}
                </button>
                <span className="pt-memory-time">
                  {formatSpotTime(location.seconds, "minutesSeconds", snapshot)}
                </span>
                <span className="pt-memory-color" role="img"
                  aria-label={location.annotation.color ? "Marker color" : "No marker color"}
                  style={{ "--pt-memory-color": location.annotation.color ?? "var(--pt-text-muted)" } as React.CSSProperties} />
                <span className="pt-memory-actions">
                  <button type="button" data-testid={`pt-memory-edit-${location.annotation.id}`}
                    onClick={() => requestEdit(location.annotation.id)}>Edit</button>
                  <button type="button" data-testid={`pt-memory-remove-${location.annotation.id}`}
                    onClick={() => void remove(location.annotation)}>Remove</button>
                </span>
              </li>
            ))}
          </ol>
          {filtered.length === 0 && <p className="pt-memory-empty" role="status">No matching Memory Locations.</p>}
        </section>
      )}
      {editor && (
        <ProToolsMemoryLocationDialog snapshot={snapshot} editor={editor}
          onClose={closeEditor} />
      )}
    </>
  );
}

function ProToolsMemoryLocationDialog({ snapshot, editor, onClose }: {
  readonly snapshot: Snapshot;
  readonly editor: ProToolsMemoryLocationEditor;
  readonly onClose: () => void;
}) {
  const exec = useStore((state) => state.exec);
  const setLastError = useStore((state) => state.setLastError);
  const annotation = editor.mode === "edit"
    ? snapshot.annotations?.find((candidate) => candidate.id === editor.annotationId)
    : undefined;
  const seconds = editor.mode === "create"
    ? editor.seconds
    : annotation ? numberedMemoryLocations(snapshot)
      .find((location) => location.annotation.id === annotation.id)?.seconds ?? 0 : 0;
  const [name, setName] = useState(annotation?.text ?? "");
  const [color, setColor] = useState(annotation?.color ?? "");
  const [storeSelection, setStoreSelection] = useState(
    annotation?.memoryLocation?.editSelection !== undefined,
  );
  const [storeZoom, setStoreZoom] = useState(
    annotation?.memoryLocation?.horizontalZoom !== undefined,
  );
  const [storeVisibility, setStoreVisibility] = useState(
    annotation?.memoryLocation?.shownTrackIds !== undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openEpoch = useRef(useStore.getState().projectEpoch);

  const dismiss = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);
  useEffect(() => pushEscapeHandler(dismiss), [dismiss]);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    nameRef.current?.focus();
    nameRef.current?.select();
    return () => {
      if (restoreFocusRef.current && document.contains(restoreFocusRef.current)) {
        restoreFocusRef.current.focus();
      }
    };
  }, []);

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
    const text = name.trim();
    if (!text) {
      setError("Enter a name for the Memory Location.");
      nameRef.current?.focus();
      return;
    }
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    const proTools = useProTools.getState();
    const memoryLocation = captureMemoryLocationProperties({
      storeSelection,
      storeZoom,
      storeVisibility,
      editSelection: useShell.getState().timeRange,
      editTrackIds: proTools.editSelectionTrackIds,
      horizontalZoom: useStore.getState().pxPerSec,
      shownTrackIds: proToolsShownTracks(snapshot.tracks, proTools.trackVisibility)
        .map((track) => track.id),
      fallbackSelection: annotation?.memoryLocation?.editSelection,
      fallbackHorizontalZoom: annotation?.memoryLocation?.horizontalZoom,
      fallbackShownTrackIds: annotation?.memoryLocation?.shownTrackIds,
    });
    const command = editor.mode === "create" ? "create_annotation" : "edit_annotation";
    const args = editor.mode === "create"
      ? {
          text,
          beat: beatAt(tempoMapFrom(snapshot.session), seconds),
          ...(color ? { color } : {}),
          ...(memoryLocation ? { memoryLocation } : {}),
        }
      : {
          annotationId: editor.annotationId,
          text,
          color,
          memoryLocation: memoryLocation ?? null,
        };
    const result = await exec(command, args);
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    if (!result.ok) {
      const message = result.error ?? "The Memory Location could not be saved.";
      setSubmitting(false);
      setError(message);
      setLastError(message);
      nameRef.current?.focus();
      return;
    }
    onClose();
  };

  return (
    <div className="pt-memory-backdrop" data-testid="pt-memory-backdrop"
      role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="pt-memory-dialog" data-testid="pt-memory-dialog"
        role="dialog" aria-modal="true" aria-labelledby="pt-memory-dialog-title"
        tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        <header>
          <div>
            <h2 id="pt-memory-dialog-title">
              {editor.mode === "create" ? "New Memory Location" : "Edit Memory Location"}
            </h2>
            <span>{formatSpotTime(seconds, "minutesSeconds", snapshot)}</span>
          </div>
          <button type="button" disabled={submitting} onClick={dismiss}>Close</button>
        </header>
        <form aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <label htmlFor="pt-memory-name">Name</label>
          <input ref={nameRef} id="pt-memory-name" data-testid="pt-memory-name"
            value={name} disabled={submitting} aria-invalid={error !== null}
            onChange={(event) => { setName(event.currentTarget.value); setError(null); }} />
          <label htmlFor="pt-memory-color">Color</label>
          <select id="pt-memory-color" value={color} disabled={submitting}
            onChange={(event) => setColor(event.currentTarget.value)}>
            {COLORS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <fieldset className="pt-memory-properties">
            <legend>Recall properties</legend>
            <label>
              <input type="checkbox" data-testid="pt-memory-store-selection"
                checked={storeSelection} disabled={submitting}
                onChange={(event) => setStoreSelection(event.currentTarget.checked)} />
              Edit selection
            </label>
            <label>
              <input type="checkbox" data-testid="pt-memory-store-zoom"
                checked={storeZoom} disabled={submitting}
                onChange={(event) => setStoreZoom(event.currentTarget.checked)} />
              Zoom
            </label>
            <label>
              <input type="checkbox" data-testid="pt-memory-store-visibility"
                checked={storeVisibility} disabled={submitting}
                onChange={(event) => setStoreVisibility(event.currentTarget.checked)} />
              Track visibility
            </label>
          </fieldset>
          {error && <p className="pt-memory-error" role="alert">{error}</p>}
          <div className="pt-memory-dialog-actions">
            <button type="button" disabled={submitting} onClick={dismiss}>Cancel</button>
            <button type="submit" data-testid="pt-memory-save" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
