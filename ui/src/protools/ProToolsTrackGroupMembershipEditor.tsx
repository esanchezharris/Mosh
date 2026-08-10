import type { RefObject } from "react";
import type { Track } from "../types";

type MembershipEditorProps = {
  readonly tracks: readonly Track[];
  readonly selectedTrackIds: readonly string[];
  readonly draftTrackIds: readonly string[];
  readonly disabled: boolean;
  readonly addButtonRef: RefObject<HTMLButtonElement>;
  readonly onChange: (trackIds: readonly string[]) => void;
};

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

export function ProToolsTrackGroupMembershipEditor({
  tracks,
  selectedTrackIds,
  draftTrackIds,
  disabled,
  addButtonRef,
  onChange,
}: MembershipEditorProps) {
  const selected = tracks.filter((track) => selectedTrackIds.includes(track.id));
  const draft = tracks.filter((track) => draftTrackIds.includes(track.id));
  const selectionIds = selected.map((track) => track.id);

  const addSelection = () => {
    const next = new Set([...draftTrackIds, ...selectionIds]);
    onChange(tracks.filter((track) => next.has(track.id)).map((track) => track.id));
  };
  const replaceWithSelection = () => onChange(selectionIds);
  const removeSelection = () => {
    const removed = new Set(selectionIds);
    onChange(draftTrackIds.filter((trackId) => !removed.has(trackId)));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey
      || event.altKey || event.shiftKey) return;
    if (event.code === "KeyA") {
      event.preventDefault();
      addSelection();
    } else if (event.code === "KeyR") {
      event.preventDefault();
      removeSelection();
    }
  };

  return (
    <div className="pt-track-group-tracks-panel" onKeyDown={handleKeyDown}>
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
        <button ref={addButtonRef} type="button" disabled={disabled || selected.length === 0}
          data-testid="pt-track-group-add-selection" aria-keyshortcuts="A" onClick={addSelection}>
          Add Selection <kbd>A</kbd>
        </button>
        <button type="button" disabled={disabled || selected.length === 0}
          data-testid="pt-track-group-replace-selection" onClick={replaceWithSelection}>
          Replace
        </button>
        <button type="button" disabled={disabled || selected.length === 0}
          data-testid="pt-track-group-remove-selection" aria-keyshortcuts="R" onClick={removeSelection}>
          Remove Selection <kbd>R</kbd>
        </button>
      </div>
    </div>
  );
}
