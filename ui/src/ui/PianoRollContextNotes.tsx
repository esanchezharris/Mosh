import type { CSSProperties } from "react";

export type PianoRollContextNote = {
  readonly key: string;
  readonly trackId: string;
  readonly trackName: string;
  readonly clipId: string;
  readonly clipName: string;
  readonly color?: string;
  readonly pitch: number;
  readonly start: number;
  readonly length: number;
  readonly velocity: number;
};

type ContextNoteStyle = CSSProperties & {
  "--pr-note"?: string;
  "--pr-note-edge"?: string;
};

export function PianoRollContextNotes({
  notes,
  beatPx,
  rowHeight,
  yOf,
}: {
  readonly notes: readonly PianoRollContextNote[];
  readonly beatPx: number;
  readonly rowHeight: number;
  readonly yOf: (pitch: number) => number;
}) {
  return notes.map((note) => {
    const y = yOf(note.pitch);
    if (y < 0) return null;
    const style: ContextNoteStyle = {
      left: note.start * beatPx,
      top: y + 1,
      width: Math.max(6, note.length * beatPx - 1),
      height: rowHeight - 2,
      ...(note.color ? {
        "--pr-note": note.color,
        "--pr-note-edge": note.color,
      } : {}),
    };
    return (
      <div
        key={note.key}
        className="pr-note pr-context-note"
        data-testid="pr-context-note"
        data-track-id={note.trackId}
        data-clip-id={note.clipId}
        aria-hidden="true"
        style={style}
      />
    );
  });
}
