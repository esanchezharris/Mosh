import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import type { Snapshot, TrackGroup } from "../types";
import { useProTools } from "./proToolsState";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

type ProToolsTrackGroupModifyDialogProps = {
  readonly snapshot: Snapshot;
  readonly group: TrackGroup;
  readonly selectedTrackIds: readonly string[];
  readonly onClose: () => void;
  readonly restoreFocus: () => void;
};

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

export function ProToolsTrackGroupModifyDialog({
  snapshot,
  group,
  selectedTrackIds,
  onClose,
  restoreFocus,
}: ProToolsTrackGroupModifyDialogProps) {
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const classicTheme = useProTools((state) => state.classicTheme);
  const dialogRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const openEpoch = useRef(projectEpoch);
  const restoreFocusRef = useRef(restoreFocus);
  const [draftIds, setDraftIds] = useState<readonly string[]>(group.trackIds);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tracks = useMemo(() => snapshot.tracks.filter((track) => !track.isGroup && !track.isReturn), [snapshot.tracks]);
  const existingIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks]);
  const selected = useMemo(() => tracks.filter((track) => selectedTrackIds.includes(track.id)), [selectedTrackIds, tracks]);
  const draft = useMemo(() => tracks.filter((track) => draftIds.includes(track.id)), [draftIds, tracks]);

  const dismiss = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  useEffect(() => pushEscapeHandler(dismiss), [dismiss]);
  useEffect(() => {
    addRef.current?.focus();
    return () => restoreFocusRef.current();
  }, []);
  useEffect(() => {
    if (projectEpoch !== openEpoch.current) onClose();
  }, [onClose, projectEpoch]);

  const selectionIds = () => tracks
    .filter((track) => selectedTrackIds.includes(track.id))
    .map((track) => track.id);
  const addSelection = () => {
    const next = new Set([...draftIds, ...selectionIds()]);
    setDraftIds(tracks.filter((track) => next.has(track.id)).map((track) => track.id));
    setError(null);
  };
  const replaceWithSelection = () => {
    setDraftIds(selectionIds());
    setError(null);
  };
  const removeSelection = () => {
    const removed = new Set(selectionIds());
    setDraftIds(draftIds.filter((trackId) => existingIds.has(trackId) && !removed.has(trackId)));
    setError(null);
  };

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    trapFocus(event);
    if (event.defaultPrevented || isEditableTarget(event.target)
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.code === "KeyA") {
      event.preventDefault();
      addSelection();
    } else if (event.code === "KeyR") {
      event.preventDefault();
      removeSelection();
    }
  };

  const apply = async () => {
    if (draftIds.length === 0) {
      setError("A Track Group must contain at least one track.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await exec("set_track_group_members", {
      groupId: group.id,
      trackIds: [...draftIds],
    });
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error ?? "Track Group membership could not be changed.");
      return;
    }
    onClose();
  };

  return createPortal(
    <div className="pt-protools-portal pt-track-group-backdrop"
      data-pt-theme={classicTheme ? "classic" : "dark"}
      data-testid="pt-track-group-modify-backdrop" role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="pt-track-group-dialog pt-track-group-modify-dialog"
        data-testid="pt-track-group-modify-dialog" role="dialog" aria-modal="true"
        aria-labelledby="pt-track-group-modify-title" aria-describedby="pt-track-group-modify-description"
        tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
        <header>
          <h2 id="pt-track-group-modify-title">Modify {group.name}</h2>
          <span>{group.kind === "edit_mix" ? "Edit + Mix" : group.kind === "edit" ? "Edit" : "Mix"}</span>
        </header>
        <div className="pt-track-group-modify-body" aria-busy={submitting}>
          <p id="pt-track-group-modify-description">
            Use the current Track Selection to change this group without changing routing.
          </p>
          <div className="pt-track-group-membership-columns">
            <section aria-labelledby="pt-track-group-selected-title">
              <h3 id="pt-track-group-selected-title">Track Selection</h3>
              <p data-testid="pt-track-group-selected">
                {selected.length > 0 ? selected.map((track) => track.name).join(", ") : "No tracks selected"}
              </p>
            </section>
            <section aria-labelledby="pt-track-group-draft-title">
              <h3 id="pt-track-group-draft-title">Currently in Group</h3>
              <p data-testid="pt-track-group-draft">
                {draft.length > 0 ? draft.map((track) => track.name).join(", ") : "No tracks in group"}
              </p>
            </section>
          </div>
          <div className="pt-track-group-modify-actions" aria-label="Modify membership">
            <button ref={addRef} type="button" disabled={submitting || selected.length === 0}
              data-testid="pt-track-group-add-selection" aria-keyshortcuts="A" onClick={addSelection}>
              Add Selection <kbd>A</kbd>
            </button>
            <button type="button" disabled={submitting || selected.length === 0}
              data-testid="pt-track-group-replace-selection" onClick={replaceWithSelection}>
              Replace
            </button>
            <button type="button" disabled={submitting || selected.length === 0}
              data-testid="pt-track-group-remove-selection" aria-keyshortcuts="R" onClick={removeSelection}>
              Remove Selection <kbd>R</kbd>
            </button>
          </div>
          {error && <p className="pt-track-group-error" role="alert">{error}</p>}
          <div className="pt-track-group-actions">
            <button type="button" disabled={submitting} onClick={dismiss}>Cancel</button>
            <button type="button" data-testid="pt-track-group-apply"
              disabled={submitting || draftIds.length === 0} onClick={() => void apply()}>
              {submitting ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
