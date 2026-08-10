import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import type { Snapshot, TrackGroupKind } from "../types";
import { IconMore, IconPlus } from "../ui/icons";
import { ProToolsTrackGroupModifyDialog } from "./ProToolsTrackGroupModifyDialog";
import { useProTools } from "./proToolsState";
import { PROTOOLS_TRACK_GROUP_KIND_LABELS, selectProToolsTrackGroup } from "./proToolsTrackGroups";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function ProToolsTrackGroupsPanel({ snapshot }: { readonly snapshot: Snapshot }) {
  const exec = useStore((state) => state.exec);
  const clearSelection = useStore((state) => state.clearSelection);
  const closePianoRoll = useStore((state) => state.closePianoRoll);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const selectedTrackIds = useProTools((state) => state.trackSelectionIds);
  const dialogOpen = useProTools((state) => state.trackGroupDialogOpen);
  const setDialogOpen = useProTools((state) => state.setTrackGroupDialogOpen);
  const [modifyGroupId, setModifyGroupId] = useState<string | null>(null);
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const eligibleTrackIds = useMemo(() => {
    const requested = new Set(selectedTrackIds.length > 0
      ? selectedTrackIds
      : selectedTrackId ? [selectedTrackId] : []);
    return snapshot.tracks
      .filter((track) => !track.isGroup && !track.isReturn && requested.has(track.id))
      .map((track) => track.id);
  }, [selectedTrackId, selectedTrackIds, snapshot.tracks]);
  const modifyGroup = (snapshot.trackGroups ?? []).find((group) => group.id === modifyGroupId);

  const selectGroup = (trackIds: readonly string[]) => {
    clearSelection();
    closePianoRoll();
    selectProToolsTrackGroup(snapshot, trackIds);
  };

  return (
    <section className="pt-track-groups" data-testid="pt-track-groups" aria-label="Track Groups">
      <header className="pt-track-groups-head">
        <span>Groups</span>
        <button type="button" className="pt-track-groups-suspend"
          data-testid="pt-track-group-suspend"
          aria-pressed={Boolean(snapshot.trackGroupsSuspended)}
          onClick={() => void exec("set_track_groups_suspended", {
            suspended: !snapshot.trackGroupsSuspended,
          })}>Suspend</button>
        <button type="button" className="pt-track-groups-new"
          data-testid="pt-track-groups-new" aria-label="Create Track Group"
          aria-keyshortcuts="Meta+G Control+G" disabled={eligibleTrackIds.length === 0}
          onClick={() => setDialogOpen(true)}><IconPlus size={11} /></button>
      </header>
      <div className="pt-track-groups-list">
        {(snapshot.trackGroups ?? []).length === 0
          ? <p className="pt-track-groups-empty">No Track Groups</p>
          : (snapshot.trackGroups ?? []).map((group) => (
            <div key={group.id} className="pt-track-group-row" data-testid="pt-track-group-row"
              data-enabled={group.enabled}>
              <button type="button" className="pt-track-group-enable"
                data-testid="pt-track-group-toggle" aria-pressed={group.enabled}
                aria-label={`${group.enabled ? "Disable" : "Enable"} ${group.name} Track Group`}
                onClick={() => void exec("set_track_group_enabled", {
                  groupId: group.id,
                  enabled: !group.enabled,
                })}>{group.enabled ? "●" : "○"}</button>
              <button type="button" className="pt-track-group-name" title={group.name}
                data-testid="pt-track-group-select"
                aria-label={`Select tracks in ${group.name} Track Group`}
                onClick={() => selectGroup(group.trackIds)}>{group.name}</button>
              <span className="pt-track-group-kind">{PROTOOLS_TRACK_GROUP_KIND_LABELS[group.kind]}</span>
              <MoshMenu label={`${group.name} Track Group actions`} align="end" trigger={(
                <button type="button" className="pt-track-group-menu-trigger"
                  ref={(node) => {
                    if (node) menuTriggerRefs.current.set(group.id, node);
                    else menuTriggerRefs.current.delete(group.id);
                  }}
                  data-testid="pt-track-group-menu" aria-label={`${group.name} Track Group actions`}>
                  <IconMore size={13} />
                </button>
              )}>
                <div className="pt-menu pt-track-group-menu">
                  <MoshMenuItem testId="pt-track-group-modify"
                    ariaLabel={`Modify ${group.name} Track Group membership`}
                    onPick={() => setModifyGroupId(group.id)}>Modify Membership…</MoshMenuItem>
                  <MoshMenuItem testId="pt-track-group-remove"
                    ariaLabel={`Remove ${group.name} Track Group`}
                    onPick={() => { void exec("remove_track_group", { groupId: group.id }); }}>
                    Remove Group
                  </MoshMenuItem>
                </div>
              </MoshMenu>
            </div>
          ))}
      </div>
      {dialogOpen && (
        <ProToolsTrackGroupDialog snapshot={snapshot} trackIds={eligibleTrackIds}
          onClose={() => setDialogOpen(false)} />
      )}
      {modifyGroup && (
        <ProToolsTrackGroupModifyDialog snapshot={snapshot} group={modifyGroup}
          selectedTrackIds={eligibleTrackIds} onClose={() => setModifyGroupId(null)}
          restoreFocus={() => menuTriggerRefs.current.get(modifyGroup.id)?.focus()} />
      )}
    </section>
  );
}

function ProToolsTrackGroupDialog({ snapshot, trackIds, onClose }: {
  readonly snapshot: Snapshot;
  readonly trackIds: readonly string[];
  readonly onClose: () => void;
}) {
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const classicTheme = useProTools((state) => state.classicTheme);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openEpoch = useRef(projectEpoch);
  const [name, setName] = useState(`Group ${(snapshot.trackGroups?.length ?? 0) + 1}`);
  const [kind, setKind] = useState<TrackGroupKind>("edit_mix");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedNames = snapshot.tracks
    .filter((track) => trackIds.includes(track.id))
    .map((track) => track.name);

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
    return () => restoreFocusRef.current?.focus();
  }, []);
  useEffect(() => {
    if (projectEpoch !== openEpoch.current) onClose();
  }, [onClose, projectEpoch]);

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

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Track Group name cannot be empty.");
      nameRef.current?.focus();
      return;
    }
    if (trackIds.length === 0) {
      setError("Select at least one track before creating a Track Group.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await exec("create_track_group", { trackIds: [...trackIds], name: trimmed, kind });
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error ?? "The Track Group could not be created.");
      return;
    }
    onClose();
  };

  return createPortal(
    <div className="pt-protools-portal pt-track-group-backdrop"
      data-pt-theme={classicTheme ? "classic" : "dark"}
      data-testid="pt-track-group-backdrop"
      role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="pt-track-group-dialog"
        data-testid="pt-track-group-dialog" role="dialog" aria-modal="true"
        aria-labelledby="pt-track-group-title" aria-describedby="pt-track-group-description"
        tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        <header><h2 id="pt-track-group-title">Create Group</h2><span>⌘G</span></header>
        <form aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <p id="pt-track-group-description">
            Link {selectedNames.length} selected track{selectedNames.length === 1 ? "" : "s"} without changing routing.
          </p>
          <label htmlFor="pt-track-group-name">Name</label>
          <input ref={nameRef} id="pt-track-group-name" data-testid="pt-track-group-name"
            value={name} disabled={submitting} aria-invalid={error !== null}
            onChange={(event) => { setName(event.currentTarget.value); setError(null); }} />
          <label htmlFor="pt-track-group-kind">Type</label>
          <select id="pt-track-group-kind" data-testid="pt-track-group-kind"
            value={kind} disabled={submitting}
            onChange={(event) => setKind(event.currentTarget.value as TrackGroupKind)}>
            {(Object.entries(PROTOOLS_TRACK_GROUP_KIND_LABELS) as [TrackGroupKind, string][])
              .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <span className="pt-track-group-members" title={selectedNames.join(", ")}>
            {selectedNames.join(", ")}
          </span>
          {error && <p className="pt-track-group-error" role="alert">{error}</p>}
          <div className="pt-track-group-actions">
            <button type="button" disabled={submitting} onClick={dismiss}>Cancel</button>
            <button type="submit" data-testid="pt-track-group-create" disabled={submitting}>
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
