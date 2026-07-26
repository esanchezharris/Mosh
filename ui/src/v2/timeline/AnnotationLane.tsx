// The annotation lane — authored timeline comment pins ("fix this transition"). Its own
// thin row, after the bar ruler and before the lanes, over the same seconds x-axis as the
// clips (mirrors TempoRibbon: a rail rather than a panel, so a project with no notes costs
// almost no vertical room). Four gestures, all mapping to commands that already existed with
// no v2 UI (classic's AnnotationRuler.tsx was the only call site, and v2 never mounts it):
//   • click empty space  → an inline text field at the clicked (piecewise) beat → create_annotation
//   • double-click a pin → inline text edit → edit_annotation
//   • drag a pin         → move_annotation
//   • ✕ (on hover)       → remove_annotation
//
// WHY THIS DOES NOT IMPORT geom.ts. Annotations are BEAT-anchored so they hold their musical
// spot across a tempo change (state/Annotation.h's own comment: "like Section"). geom.ts's
// beatToSec/secToBeat derive everything from ONE meterFrom(session.tempo) reading — correct
// only while the tempo never changes, which is exactly the case this feature has to survive.
// Positions here go through time.ts's PIECEWISE map (tempoMapFrom + the new beatAt/secAtBeat,
// which mirror this file's already-private barPosAt/barPosToSec but in beats rather than
// bars). Copying SectionRibbon's beatToSec/secToBeat calls would have looked right and placed
// every pin after the first tempo change in the wrong spot.
//
// The drag/double-click detection is the SAME manual pointerdown/pointerup pattern
// SectionRibbon uses (rather than native dblclick), because a single element here has to
// serve both a drag gesture (pointer capture across pointerdown/move/up) and a double-click
// gesture, and both need to key off which specific pin the previous click landed on — several
// pins share this one lane instance.
//
// SCOPE, deliberately: unlike classic's AnnotationRuler, editing text does NOT also delete on
// an empty commit. v2 has an explicit, always-present remove control (the ✕), so an
// edit-to-empty here just reverts rather than silently deleting — one gesture, one outcome.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import type { Snapshot, Annotation } from "../../types";
import { tempoMapFrom, beatAt, secAtBeat } from "../../time";
import { passedDragThreshold, isDoubleClick } from "../../interaction/feel";
import { liveFeel } from "../../interaction/config";

export function AnnotationLane({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const mpActive = useStore((s) => s.mp.active);
  const selfPeer = useStore((s) => s.mp.selfPeer);
  const peers = useStore((s) => s.peers);
  const selfName = (mpActive && selfPeer && peers[selfPeer]?.name) || "you";

  const map = tempoMapFrom(snapshot.session);
  const annotations = snapshot.annotations ?? [];

  const [draft, setDraft] = useState<{ beat: number; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [dragPreview, setDragPreview] = useState<{ id: string; beat: number } | null>(null);
  const drag = useRef<{ id: string; startX: number; engaged: boolean; origBeat: number } | null>(null);
  // Keyed by pin id, mirroring SectionRibbon: several pins share this one lane instance, so a
  // quick click on a DIFFERENT pin must not be misread as a double-click on the first.
  const lastUp = useRef<{ id: string; t: number } | null>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (draft && draftInputRef.current) draftInputRef.current.focus(); }, [draft]);
  useEffect(() => { if (editingId && editInputRef.current) { editInputRef.current.focus(); editInputRef.current.select(); } }, [editingId]);

  // Clear the drag preview only once the committed snapshot reflects the move (mirrors
  // SectionRibbon/ClipView's commit-then-reconcile), so the pin never snaps back to its old
  // position for a frame between dispatch and the async snapshot_invalidated round-trip.
  useEffect(() => {
    if (!dragPreview) return;
    const a = annotations.find((x) => x.id === dragPreview.id);
    if (a && a.beat === dragPreview.beat) setDragPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, dragPreview]);

  const openCreateAt = (clientX: number, rect: DOMRect) => {
    const sec = Math.max(0, (clientX - rect.left) / pxPerSec);
    setDraft({ beat: beatAt(map, sec), text: "" });
  };

  const commitCreate = async () => {
    if (!draft) return;
    const text = draft.text.trim();
    const beat = draft.beat;
    setDraft(null);
    if (!text) return; // nothing typed — abandon rather than create a blank note
    await exec("create_annotation", { text, beat, author: selfName });
  };

  const commitEdit = async (a: Annotation) => {
    const text = editDraft.trim();
    setEditingId(null);
    if (!text || text === a.text) return; // empty reverts rather than deleting — ✕ is the delete gesture
    await exec("edit_annotation", { annotationId: a.id, text });
  };

  const removePin = (a: Annotation) => void exec("remove_annotation", { annotationId: a.id });

  const onDown = (e: React.PointerEvent, a: Annotation) => {
    if (e.button !== 0 || editingId === a.id) return;
    e.stopPropagation();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no-op */ }
    drag.current = { id: a.id, startX: e.clientX, engaged: false, origBeat: a.beat };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.engaged) { if (!passedDragThreshold(dx, 0, liveFeel().dragThreshold)) return; d.engaged = true; }
    const origSec = secAtBeat(map, d.origBeat);
    const newBeat = Math.max(0, beatAt(map, origSec + dx / pxPerSec));
    setDragPreview({ id: d.id, beat: newBeat });
  };

  const onUp = (e: React.PointerEvent, a: Annotation) => {
    const d = drag.current; drag.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    if (editingId === a.id) return; // mid-edit: ignore stray pointerups on this pin
    if (d && d.engaged) {
      lastUp.current = null;
      const moved = dragPreview && dragPreview.id === d.id && dragPreview.beat !== d.origBeat;
      if (moved) {
        // Hold the preview until the committed snapshot lands (the effect above clears it);
        // revert immediately only if the move is rejected (e.g. a multiplayer lock).
        void exec("move_annotation", { annotationId: d.id, beat: dragPreview!.beat })
          .then((r) => { if (!r.ok) setDragPreview(null); });
      } else {
        setDragPreview(null);
      }
      return;
    }
    const now = performance.now();
    if (lastUp.current?.id === a.id && isDoubleClick(lastUp.current.t, now, liveFeel().doubleClickMs)) {
      lastUp.current = null;
      setEditingId(a.id);
      setEditDraft(a.text);
    } else {
      lastUp.current = { id: a.id, t: now };
    }
  };

  return (
    <div
      className="v2-annlane" style={{ width }} data-testid="v2-annotation-lane"
      // CLICK, not pointerdown — see TempoRibbon for why: a real mouse press is
      // pointerdown -> mousedown -> mouseup, and the mousedown would land on the lane and
      // blur an input opened on pointerdown, whose onBlur commits and closes it before a
      // keystroke lands.
      onClick={(e) => {
        if (e.target !== e.currentTarget) return; // let pins and inputs handle their own
        openCreateAt(e.clientX, e.currentTarget.getBoundingClientRect());
      }}
      title="Click to add a note"
    >
      {annotations.map((a) => {
        const beat = dragPreview && dragPreview.id === a.id ? dragPreview.beat : a.beat;
        const left = secAtBeat(map, beat) * pxPerSec;
        const editing = editingId === a.id;
        return (
          <div
            key={a.id} className={`v2-ann-pin${editing ? " editing" : ""}`} style={{ left }}
            data-testid="v2-annotation" data-annotation-id={a.id} data-beat={beat}
            title={editing ? undefined : `${a.text}${a.author ? " — " + a.author : ""}`}
            onPointerDown={(e) => onDown(e, a)}
            onPointerMove={onMove}
            onPointerUp={(e) => onUp(e, a)}
          >
            <span className="v2-ann-flag" style={{ background: a.color ?? "var(--v2-accent)" }} aria-hidden="true">📍</span>
            {editing ? (
              <input
                ref={editInputRef} className="v2-ann-edit-input" data-testid="v2-annotation-edit"
                value={editDraft}
                aria-label="Edit annotation text"
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void commitEdit(a); }
                  else if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                }}
                onBlur={() => void commitEdit(a)}
              />
            ) : (
              <span className="v2-ann-text">{a.text}</span>
            )}
            <button
              className="v2-ann-rm" data-testid="v2-annotation-remove"
              title="Remove this note" aria-label={`Remove annotation: ${a.text}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); removePin(a); }}
            >×</button>
          </div>
        );
      })}
      {draft && (
        <input
          ref={draftInputRef} className="v2-ann-draft-input" data-testid="v2-annotation-input"
          style={{ left: secAtBeat(map, draft.beat) * pxPerSec }}
          value={draft.text}
          placeholder="New note…"
          aria-label="New annotation text"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commitCreate(); }
            else if (e.key === "Escape") { e.preventDefault(); setDraft(null); }
          }}
          onBlur={() => void commitCreate()}
        />
      )}
    </div>
  );
}
