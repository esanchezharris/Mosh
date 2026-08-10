import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { useStore } from "../store";
import type { Clip, Snapshot } from "../types";
import { IconChevronLeft, IconChevronRight, IconLayers } from "../ui/icons";
import {
  activeClipGroupForClip,
  proToolsClipListEntries,
  type ProToolsClipListEntry,
} from "./proToolsClipGroups";

type ProToolsClipListProps = {
  readonly snapshot: Snapshot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

const MEDIA_LABELS = {
  midi: "MIDI",
  wave: "Audio",
  clip: "Clip",
} as const satisfies Readonly<Record<Clip["type"], string>>;

export function ProToolsClipList({ snapshot, open, onOpenChange }: ProToolsClipListProps) {
  const selection = useStore((state) => state.selection);
  const select = useStore((state) => state.select);
  const setSelectedTrack = useStore((state) => state.setSelectedTrack);
  const openPianoRoll = useStore((state) => state.openPianoRoll);
  const exec = useStore((state) => state.exec);
  const entries = proToolsClipListEntries(snapshot);
  const selectedClipIds = snapshot.tracks.flatMap((track) => track.clips)
    .filter((clip) => selection.has(clip.id) && !clip.hidden)
    .map((clip) => clip.id);
  const activeMember = selectedClipIds.find((clipId) => activeClipGroupForClip(snapshot, clipId));
  const canGroup = selectedClipIds.length >= 2
    && selectedClipIds.every((clipId) => !activeClipGroupForClip(snapshot, clipId));
  const canRegroup = Boolean(snapshot.lastUngroupedClipGroupId
    && snapshot.clipGroups?.some((group) =>
      group.id === snapshot.lastUngroupedClipGroupId && !group.active));

  const openClip = (entry: ProToolsClipListEntry) => {
    select([...entry.clipIds]);
    setSelectedTrack(entry.track.id);
    if (entry.kind === "clip") openPianoRoll(entry.clip.id);
  };

  return (
    <aside
      className={`pt-clip-list${open ? " is-open" : " is-closed"}`}
      data-testid="pt-clip-list"
      aria-label="Clip List"
    >
      <header className="pt-clip-list-head">
        {open && <span>Clip List</span>}
        {open && (
          <MoshMenu
            label="Clip Group actions"
            align="end"
            trigger={(
              <button type="button" className="pt-clip-group-menu-trigger"
                data-testid="pt-clip-group-menu" aria-label="Clip Group actions">
                <IconLayers size={12} />
              </button>
            )}
          >
            <div className="pt-menu pt-clip-group-menu" data-testid="pt-clip-group-actions">
              <MoshMenuItem testId="pt-clip-group-create" disabled={!canGroup}
                ariaLabel="Group selected clips, Command Option G"
                onPick={() => { void exec("create_clip_group", { clipIds: selectedClipIds }); }}>
                <span>Group</span><kbd>⌘⌥G</kbd>
              </MoshMenuItem>
              <MoshMenuItem testId="pt-clip-group-ungroup" disabled={!activeMember}
                ariaLabel="Ungroup selected clip group, Command Option U"
                onPick={() => { if (activeMember) void exec("ungroup_clip_group", { clipId: activeMember }); }}>
                <span>Ungroup</span><kbd>⌘⌥U</kbd>
              </MoshMenuItem>
              <MoshMenuItem testId="pt-clip-group-regroup" disabled={!canRegroup}
                ariaLabel="Regroup last clip group, Command Option R"
                onPick={() => { void exec("regroup_clip_group", {}); }}>
                <span>Regroup</span><kbd>⌘⌥R</kbd>
              </MoshMenuItem>
            </div>
          </MoshMenu>
        )}
        <button
          type="button"
          className="pt-clip-list-toggle"
          data-testid="pt-clip-list-toggle"
          aria-label={open ? "Collapse Clip List" : "Expand Clip List"}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >{open ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />}</button>
      </header>
      {open && (
        entries.length === 0
          ? <p className="pt-clip-list-empty" role="status">No clips in this session</p>
          : (
            <ul className="pt-clip-list-items">
              {entries.map((entry) => {
                const selected = entry.clipIds.some((clipId) => selection.has(clipId));
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="pt-clip-list-item"
                      data-testid="pt-clip-list-item"
                      data-entry-kind={entry.kind}
                      data-selected={selected}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => openClip(entry)}
                    >
                      <span className="pt-clip-list-kind">
                        {entry.kind === "group" ? "Group" : MEDIA_LABELS[entry.clip.type]}
                      </span>
                      <span className="pt-clip-list-name" title={entry.name}>{entry.name}</span>
                      <span className="pt-clip-list-track">
                        {entry.kind === "group" ? `${entry.memberCount} clips` : entry.track.name}
                      </span>
                      <span className="pt-clip-list-time">{entry.clip.start.toFixed(2)} s</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
      )}
    </aside>
  );
}
