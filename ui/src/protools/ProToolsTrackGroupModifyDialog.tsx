import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import { TRACK_GROUP_MIX_ATTRIBUTES } from "../types";
import type { Snapshot, TrackGroup, TrackGroupKind, TrackGroupMixAttribute } from "../types";
import { useProTools } from "./proToolsState";
import { ProToolsTrackGroupMembershipEditor } from "./ProToolsTrackGroupMembershipEditor";
import {
  PROTOOLS_TRACK_GROUP_ATTRIBUTE_LABELS,
  PROTOOLS_TRACK_GROUP_KIND_LABELS,
  PROTOOLS_TRACK_GROUP_KINDS,
  isProToolsTrackGroupKind,
  proToolsTrackGroupMixAttributes,
} from "./proToolsTrackGroups";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
type TrackGroupConfigTab = "tracks" | "attributes";
export type TrackGroupDialogMode = "modify" | "duplicate";

type ProToolsTrackGroupModifyDialogProps = {
  readonly snapshot: Snapshot;
  readonly group: TrackGroup;
  readonly mode: TrackGroupDialogMode;
  readonly selectedTrackIds: readonly string[];
  readonly onClose: () => void;
  readonly restoreFocus: () => void;
};

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function ProToolsTrackGroupModifyDialog({
  snapshot,
  group,
  mode,
  selectedTrackIds,
  onClose,
  restoreFocus,
}: ProToolsTrackGroupModifyDialogProps) {
  const exec = useStore((state) => state.exec);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const classicTheme = useProTools((state) => state.classicTheme);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const tracksTabRef = useRef<HTMLButtonElement>(null);
  const attributesTabRef = useRef<HTMLButtonElement>(null);
  const openEpoch = useRef(projectEpoch);
  const restoreFocusRef = useRef(restoreFocus);
  const [name, setName] = useState(mode === "duplicate" ? `${group.name} Copy` : group.name);
  const [kind, setKind] = useState<TrackGroupKind>(group.kind);
  const [draftTrackIds, setDraftTrackIds] = useState<readonly string[]>(group.trackIds);
  const [mixAttributes, setMixAttributes] = useState<readonly TrackGroupMixAttribute[]>(
    proToolsTrackGroupMixAttributes(group),
  );
  const [activeTab, setActiveTab] = useState<TrackGroupConfigTab>("tracks");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tracks = useMemo(
    () => snapshot.tracks.filter((track) => !track.isGroup && !track.isReturn),
    [snapshot.tracks],
  );

  const dismiss = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  useEffect(() => pushEscapeHandler(dismiss), [dismiss]);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
    return () => restoreFocusRef.current();
  }, []);
  useEffect(() => {
    if (projectEpoch !== openEpoch.current) onClose();
  }, [onClose, projectEpoch]);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((control) => control.closest("[hidden]") === null);
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

  const toggleAttribute = (attribute: TrackGroupMixAttribute) => {
    const selected = new Set(mixAttributes);
    if (selected.has(attribute)) selected.delete(attribute);
    else selected.add(attribute);
    setMixAttributes(TRACK_GROUP_MIX_ATTRIBUTES.filter((candidate) => selected.has(candidate)));
    setError(null);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let nextTab: TrackGroupConfigTab | null = null;
    if (event.key === "ArrowLeft" || event.key === "Home") nextTab = "tracks";
    else if (event.key === "ArrowRight" || event.key === "End") nextTab = "attributes";
    if (!nextTab) return;
    event.preventDefault();
    setActiveTab(nextTab);
    (nextTab === "tracks" ? tracksTabRef : attributesTabRef).current?.focus();
  };

  const apply = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Track Group name cannot be empty.");
      nameRef.current?.focus();
      return;
    }
    if (draftTrackIds.length === 0) {
      setError("A Track Group must contain at least one track.");
      setActiveTab("tracks");
      return;
    }
    setSubmitting(true);
    setError(null);
    const definition = {
      groupId: group.id,
      name: trimmedName,
      kind,
      trackIds: [...draftTrackIds],
      mixAttributes: [...mixAttributes],
    };
    const definitionChanged = trimmedName !== group.name || kind !== group.kind
      || !sameValues(mixAttributes, proToolsTrackGroupMixAttributes(group));
    const result = mode === "duplicate"
      ? await exec("duplicate_track_group", definition)
      : definitionChanged
        ? await exec("configure_track_group", definition)
        : await exec("set_track_group_members", {
          groupId: group.id,
          trackIds: [...draftTrackIds],
        });
    if (useStore.getState().projectEpoch !== openEpoch.current) {
      onClose();
      return;
    }
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error ?? `The Track Group could not be ${mode === "duplicate" ? "duplicated" : "changed"}.`);
      return;
    }
    onClose();
  };

  const title = mode === "duplicate" ? `Duplicate ${group.name}` : `Modify ${group.name}`;
  return createPortal(
    <div className="pt-protools-portal pt-track-group-backdrop"
      data-pt-theme={classicTheme ? "classic" : "dark"}
      data-testid="pt-track-group-modify-backdrop" role="presentation" onClick={dismiss}>
      <section ref={dialogRef} className="pt-track-group-dialog pt-track-group-modify-dialog"
        data-testid="pt-track-group-modify-dialog" role="dialog" aria-modal="true"
        aria-labelledby="pt-track-group-modify-title" aria-describedby="pt-track-group-modify-description"
        tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        <header>
          <h2 id="pt-track-group-modify-title">{title}</h2>
          <span>{PROTOOLS_TRACK_GROUP_KIND_LABELS[kind]}</span>
        </header>
        <div className="pt-track-group-modify-body" aria-busy={submitting}>
          <p id="pt-track-group-modify-description">
            Configure non-routing Edit and Mix linkage for this Track Group.
          </p>
          <div className="pt-track-group-definition-fields">
            <label htmlFor="pt-track-group-modify-name">Name</label>
            <input ref={nameRef} id="pt-track-group-modify-name"
              data-testid="pt-track-group-modify-name" value={name} disabled={submitting}
              aria-invalid={error !== null && name.trim().length === 0}
              onChange={(event) => { setName(event.currentTarget.value); setError(null); }} />
            <label htmlFor="pt-track-group-modify-kind">Type</label>
            <select id="pt-track-group-modify-kind" data-testid="pt-track-group-modify-kind"
              value={kind} disabled={submitting}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isProToolsTrackGroupKind(value)) setKind(value);
              }}>
              {PROTOOLS_TRACK_GROUP_KINDS.map((value) => (
                <option key={value} value={value}>{PROTOOLS_TRACK_GROUP_KIND_LABELS[value]}</option>
              ))}
            </select>
          </div>
          <div className="pt-track-group-tabs" role="tablist" aria-label="Track Group settings">
            <button ref={tracksTabRef} type="button" role="tab" id="pt-track-group-tab-tracks"
              data-testid="pt-track-group-tab-tracks" aria-selected={activeTab === "tracks"}
              tabIndex={activeTab === "tracks" ? 0 : -1}
              aria-controls="pt-track-group-panel-tracks" onKeyDown={handleTabKeyDown}
              onClick={() => setActiveTab("tracks")}>Tracks</button>
            <button ref={attributesTabRef} type="button" role="tab" id="pt-track-group-tab-attributes"
              data-testid="pt-track-group-tab-attributes" aria-selected={activeTab === "attributes"}
              tabIndex={activeTab === "attributes" ? 0 : -1}
              aria-controls="pt-track-group-panel-attributes" onKeyDown={handleTabKeyDown}
              onClick={() => setActiveTab("attributes")}>Supported Attributes</button>
          </div>
          <div id="pt-track-group-panel-tracks" role="tabpanel"
            aria-labelledby="pt-track-group-tab-tracks" hidden={activeTab !== "tracks"}>
            <ProToolsTrackGroupMembershipEditor tracks={tracks}
              selectedTrackIds={selectedTrackIds} draftTrackIds={draftTrackIds}
              disabled={submitting} addButtonRef={addRef}
              onChange={(trackIds) => { setDraftTrackIds(trackIds); setError(null); }} />
          </div>
          <div id="pt-track-group-panel-attributes" role="tabpanel"
            aria-labelledby="pt-track-group-tab-attributes" hidden={activeTab !== "attributes"}>
            <fieldset className="pt-track-group-attributes" disabled={submitting}>
              <legend>Linked Mix controls</legend>
              {TRACK_GROUP_MIX_ATTRIBUTES.map((attribute) => (
                <label key={attribute}>
                  <input type="checkbox" data-testid={`pt-track-group-attribute-${attribute}`}
                    checked={mixAttributes.includes(attribute)}
                    onChange={() => toggleAttribute(attribute)} />
                  <span>{PROTOOLS_TRACK_GROUP_ATTRIBUTE_LABELS[attribute]}</span>
                </label>
              ))}
            </fieldset>
          </div>
          {error && <p className="pt-track-group-error" role="alert">{error}</p>}
          <div className="pt-track-group-actions">
            <button type="button" disabled={submitting} onClick={dismiss}>Cancel</button>
            <button type="button" data-testid="pt-track-group-apply"
              disabled={submitting || draftTrackIds.length === 0} onClick={() => void apply()}>
              {submitting ? "Applying…" : mode === "duplicate" ? "Duplicate" : "Apply"}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
