import { useStore } from "../store";
import type { Clip, Snapshot, Track } from "../types";
import { IconChevronLeft, IconChevronRight } from "../ui/icons";

type ProToolsClipListProps = {
  readonly snapshot: Snapshot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

type ClipListEntry = {
  readonly clip: Clip;
  readonly track: Track;
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
  const entries: readonly ClipListEntry[] = snapshot.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => !clip.hidden)
      .map((clip) => ({ clip, track })),
  );

  const openClip = (entry: ClipListEntry) => {
    select([entry.clip.id]);
    setSelectedTrack(entry.track.id);
    openPianoRoll(entry.clip.id);
  };

  return (
    <aside
      className={`pt-clip-list${open ? " is-open" : " is-closed"}`}
      data-testid="pt-clip-list"
      aria-label="Clip List"
    >
      <header className="pt-clip-list-head">
        {open && <span>Clip List</span>}
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
                const selected = selection.has(entry.clip.id);
                return (
                  <li key={entry.clip.id}>
                    <button
                      type="button"
                      className="pt-clip-list-item"
                      data-testid="pt-clip-list-item"
                      data-selected={selected}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => openClip(entry)}
                    >
                      <span className="pt-clip-list-kind">{MEDIA_LABELS[entry.clip.type]}</span>
                      <span className="pt-clip-list-name" title={entry.clip.name}>{entry.clip.name}</span>
                      <span className="pt-clip-list-track">{entry.track.name}</span>
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
