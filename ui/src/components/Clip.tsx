import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Clip as ClipT } from "../types";
import { Waveform } from "./Waveform";
import { MidiNotePreview } from "./MidiNotePreview";

type Pos = { start: number; length: number; offset: number };
type DragKind = "move" | "trim-l" | "trim-r" | null;

const LANE_H = 84;
const CLIP_PAD = 8;

export function Clip({ clip }: { clip: ClipT }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const tool = useStore((s) => s.tool);
  const snapTime = useStore((s) => s.snapTime);
  const exec = useStore((s) => s.exec);
  const selected = useStore((s) => s.selection.has(clip.id));
  const select = useStore((s) => s.select);
  const peaks = useStore((s) => s.peaks[clip.id]);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const setCtxMenu = useStore((s) => s.setCtxMenu);

  // Optimistic preview while dragging; cleared when committed props arrive.
  const [preview, setPreview] = useState<Pos | null>(null);
  const dragRef = useRef<{ kind: DragKind; startX: number; orig: Pos } | null>(null);

  useEffect(() => {
    setPreview(null);
  }, [clip.start, clip.length, clip.offset]);

  const pos: Pos = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const left = pos.start * pxPerSec;
  const width = Math.max(10, pos.length * pxPerSec);

  const srcLen = clip.sourceLength && clip.sourceLength > 0 ? clip.sourceLength : pos.length;
  const offsetFrac = Math.min(1, Math.max(0, pos.offset / srcLen));
  const lengthFrac = Math.min(1 - offsetFrac, pos.length / srcLen);

  const onPointerDown = (kind: DragKind) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (tool === "split" && kind === "move") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const t = snapTime(clip.start + (e.clientX - rect.left) / pxPerSec);
      void exec("split_clip", { clipId: clip.id, time: t });
      return;
    }
    select([clip.id], e.shiftKey);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      startX: e.clientX,
      orig: { start: clip.start, length: clip.length, offset: clip.offset },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = (e.clientX - d.startX) / pxPerSec;
    const o = d.orig;
    if (d.kind === "move") {
      const start = Math.max(0, snapTime(o.start + delta));
      setPreview({ ...o, start });
    } else if (d.kind === "trim-r") {
      const end = snapTime(o.start + o.length + delta);
      setPreview({ ...o, length: Math.max(0.05, end - o.start) });
    } else if (d.kind === "trim-l") {
      const start = Math.max(0, Math.min(o.start + o.length - 0.05, snapTime(o.start + delta)));
      const used = start - o.start;
      setPreview({ start, length: o.length - used, offset: Math.max(0, o.offset + used) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !preview) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d.kind === "move") {
      if (Math.abs(preview.start - d.orig.start) > 1e-4)
        void exec("move_clip", { clipId: clip.id, start: preview.start });
      else setPreview(null);
    } else {
      void exec("trim_clip", {
        clipId: clip.id,
        start: preview.start,
        length: preview.length,
        offset: preview.offset,
      });
    }
  };

  return (
    <div
      className={`clip ${clip.type} ${selected ? "sel" : ""} ${tool === "split" ? "splitcur" : ""}`}
      style={{ left, width, height: LANE_H - CLIP_PAD * 2, top: CLIP_PAD }}
      onPointerDown={onPointerDown("move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        select([clip.id], false);
        setCtxMenu({ x: e.clientX, y: e.clientY, clipId: clip.id });
      }}
      onDoubleClick={(e) => {
        if (clip.type !== "midi") return;
        e.stopPropagation();
        useStore.getState().setEditingClip(clip.id);
      }}
      title={`${clip.name} · ${pos.length.toFixed(2)}s`}
    >
      <div className="clip-wave">
        {clip.type === "midi" ? (
          <MidiNotePreview
            notes={clip.notes ?? []}
            lengthBeats={Math.max(0.25, pos.length / secsPerBeat())}
            width={Math.max(1, width - 2)}
            height={LANE_H - CLIP_PAD * 2 - 16}
          />
        ) : (
          <Waveform
            peaks={peaks}
            width={Math.max(1, width - 2)}
            height={LANE_H - CLIP_PAD * 2 - 16}
            offsetFrac={offsetFrac}
            lengthFrac={lengthFrac}
            color="rgba(255,255,255,0.85)"
          />
        )}
      </div>
      {useStore((st) => st.renamingClipId) === clip.id ? (
        <input
          className="clip-rename"
          autoFocus
          defaultValue={clip.name}
          onFocus={(ev) => ev.target.select()}
          onPointerDown={(ev) => ev.stopPropagation()}
          onBlur={(ev) => {
            const name = ev.target.value.trim();
            useStore.getState().setRenamingClip(null);
            if (name && name !== clip.name) void exec("rename_clip", { clipId: clip.id, name });
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
            if (ev.key === "Escape") useStore.getState().setRenamingClip(null);
          }}
        />
      ) : (
        <span className="clip-name">{clip.name}</span>
      )}
      {clip.hasRenderLayer && <span className="rl-badge">RL</span>}
      {tool === "move" && (
        <>
          <div className="trim-h left" onPointerDown={onPointerDown("trim-l")} />
          <div className="trim-h right" onPointerDown={onPointerDown("trim-r")} />
        </>
      )}
    </div>
  );
}
