// The song-structure ribbon (INTRO / VERSE / HOOK / …). Reads snapshot.sections,
// positions each segment on the shared seconds x-axis, and is fully editable through the
// existing section commands (zero new backend surface):
//   • "+"            → create_section (appended after the last, auto-opens rename)
//   • single click   → seek (set_transport)
//   • double click   → rename_section (inline input)
//   • drag body/edge → move_section (move / resize, snapped to the bar)
//   • ✕ (on hover)   → remove_section
// The drag/feel math is the SAME shared layer the clips use (drag threshold + manual
// double-click detection) so the ribbon feels identical to the lanes.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import type { Snapshot, Section } from "../../types";
import { beatToSec, secToBeat, beatsPerBar } from "./geom";
import { passedDragThreshold, isDoubleClick } from "../../interaction/feel";
import { liveFeel } from "../../interaction/config";

const SEG_COLORS = ["#7d8cff", "#9b8cff", "#6fa8ff", "#8c7dff", "#6fb6ff"];
const EDGE_PX = 7;          // edge-grab zone for resize
const DEFAULT_SPAN_BARS = 4; // a freshly created section spans this many bars

type DragKind = "move" | "resize-l" | "resize-r";
type Pos = { startBeat: number; endBeat: number };

export function SectionRibbon({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const sections = snapshot.sections ?? [];
  const bpb = beatsPerBar(snapshot);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<({ id: string } & Pos) | null>(null);
  // State (not a ref) so the open-on-arrival effect re-runs whether the new section's
  // snapshot lands before or after we learn its id — create() resolves async.
  const [pendingRename, setPendingRename] = useState<string | null>(null);
  const drag = useRef<{ id: string; kind: DragKind; startX: number; engaged: boolean; orig: Pos } | null>(null);
  // The last pure-click carries its section id so a quick click on a DIFFERENT section
  // isn't misread as a double-click (all segments share this one ribbon instance).
  const lastUp = useRef<{ id: string; t: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const beatPx = beatToSec(snapshot, 1) * pxPerSec;
  const pxToBeat = (px: number) => secToBeat(snapshot, px / pxPerSec);
  const snapBar = (beat: number) => Math.max(0, Math.round(beat / bpb) * bpb);
  const lastEnd = sections.reduce((m, s) => Math.max(m, s.endBeat), 0);
  const addLeft = beatToSec(snapshot, lastEnd) * pxPerSec; // ghost "+" sits after the last section

  // After a create, the new section arrives on the next snapshot — open it for rename.
  // Depends on both pendingRename AND sections so it fires regardless of which lands first.
  useEffect(() => {
    if (!pendingRename) return;
    const sec = sections.find((s) => s.id === pendingRename);
    if (sec) { setEditingId(sec.id); setDraft(sec.name); setPendingRename(null); }
  }, [sections, pendingRename]);

  useEffect(() => {
    if (editingId && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editingId]);

  // Clear the drag preview only once the committed snapshot reflects the move (mirrors
  // ClipView's commit-then-reconcile) so the segment never snaps back to its old position
  // for a frame between dispatch and the async snapshot_invalidated round-trip.
  useEffect(() => {
    if (!preview) return;
    const sec = sections.find((s) => s.id === preview.id);
    if (sec && sec.startBeat === preview.startBeat && sec.endBeat === preview.endBeat) setPreview(null);
  }, [sections, preview]);

  const createSection = async () => {
    const start = snapBar(lastEnd);
    const end = start + DEFAULT_SPAN_BARS * bpb;
    const r = await exec("create_section", { name: "Section", startBeat: start, endBeat: end });
    const id = (r.ok && r.data && typeof (r.data as { sectionId?: unknown }).sectionId === "string")
      ? (r.data as { sectionId: string }).sectionId : null;
    if (id) setPendingRename(id);
  };

  const commitRename = (id: string) => {
    const sec = sections.find((s) => s.id === id);
    const name = draft.trim();
    if (sec && name && name !== sec.name) void exec("rename_section", { sectionId: id, name });
    setEditingId(null);
  };

  const onDown = (e: React.PointerEvent, sec: Section) => {
    if (e.button !== 0 || editingId === sec.id) return;
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const kind: DragKind = localX <= EDGE_PX ? "resize-l" : localX >= rect.width - EDGE_PX ? "resize-r" : "move";
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no-op */ }
    drag.current = { id: sec.id, kind, startX: e.clientX, engaged: false, orig: { startBeat: sec.startBeat, endBeat: sec.endBeat } };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.engaged) { if (!passedDragThreshold(dx, 0, liveFeel().dragThreshold)) return; d.engaged = true; }
    const db = pxToBeat(dx), o = d.orig;
    if (d.kind === "move") {
      const start = snapBar(Math.max(0, o.startBeat + db));
      setPreview({ id: d.id, startBeat: start, endBeat: start + (o.endBeat - o.startBeat) });
    } else if (d.kind === "resize-r") {
      const end = Math.max(o.startBeat + bpb, snapBar(o.endBeat + db));
      setPreview({ id: d.id, startBeat: o.startBeat, endBeat: end });
    } else {
      const start = Math.min(o.endBeat - bpb, snapBar(Math.max(0, o.startBeat + db)));
      setPreview({ id: d.id, startBeat: start, endBeat: o.endBeat });
    }
  };

  const onUp = (e: React.PointerEvent, sec: Section) => {
    const d = drag.current; drag.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    if (editingId === sec.id) return; // mid-rename: ignore stray pointerups on this segment
    if (d && d.engaged) {
      lastUp.current = null;
      const moved = preview && (preview.startBeat !== d.orig.startBeat || preview.endBeat !== d.orig.endBeat);
      if (moved) {
        // Hold the preview until the committed snapshot lands (the effect above clears it);
        // revert immediately only if the move is rejected (e.g. a multiplayer lock).
        void exec("move_section", { sectionId: d.id, startBeat: preview!.startBeat, endBeat: preview!.endBeat })
          .then((r) => { if (!r.ok) setPreview(null); });
      } else {
        setPreview(null);
      }
      return;
    }
    const now = performance.now();
    // Double-click → rename, but ONLY when both clicks landed on the same section.
    if (lastUp.current?.id === sec.id && isDoubleClick(lastUp.current.t, now, liveFeel().doubleClickMs)) {
      lastUp.current = null;
      setEditingId(sec.id);
      setDraft(sec.name);
    } else {
      lastUp.current = { id: sec.id, t: now };
      void exec("set_transport", { position: beatToSec(snapshot, sec.startBeat) });
    }
  };

  return (
    <div className="v2-ribbon" style={{ width }} data-testid="v2-section-ribbon">
      <button className="v2-seg-add" title="Add section" aria-label="Add section" data-testid="v2-section-add" style={{ left: addLeft }} onClick={() => void createSection()}>+</button>
      {sections.map((sec, i) => {
        const p = preview && preview.id === sec.id ? preview : sec;
        const left = beatToSec(snapshot, p.startBeat) * pxPerSec;
        const w = Math.max(beatPx, (beatToSec(snapshot, p.endBeat) - beatToSec(snapshot, p.startBeat)) * pxPerSec);
        const color = sec.color ?? SEG_COLORS[i % SEG_COLORS.length];
        const editing = editingId === sec.id;
        return (
          <div
            key={sec.id}
            className={`v2-seg${editing ? " editing" : ""}`}
            style={{ left, width: w }}
            title={`${sec.name} — click to jump, double-click to rename`}
            data-testid="v2-section" data-section-id={sec.id} data-start-beat={p.startBeat}
            onPointerDown={(e) => onDown(e, sec)}
            onPointerMove={onMove}
            onPointerUp={(e) => onUp(e, sec)}
          >
            {editing ? (
              <input
                ref={inputRef}
                className="v2-seg-input"
                data-testid="v2-section-rename"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(sec.id); }
                  else if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                }}
                onBlur={() => commitRename(sec.id)}
              />
            ) : (
              <span className="v2-seg-name">{sec.name}</span>
            )}
            <button
              className="v2-seg-rm" title="Remove section" aria-label="Remove section" data-testid="v2-section-remove"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); void exec("remove_section", { sectionId: sec.id }); }}
            >×</button>
            <span className="v2-seg-bar" style={{ background: color }} />
          </div>
        );
      })}
    </div>
  );
}
