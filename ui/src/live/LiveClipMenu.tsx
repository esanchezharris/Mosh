// The live shell's clip context menu (SPEC §8 + the captured Live inventory in
// .cache/live-ref/09-ctxmenu.png). Live 12's menu, capability-gated: every entry
// routes through an existing moshop (or the UI-local grid/snap state) — Freeze
// Track is REAL (freeze_track/unfreeze_track, ⌥⇧⌘F — the row flips on a frozen
// track), as are Crop Clip (crop_clip, ⇧⌘J) and Bounce (bounce_track, ⌘B).
//
// Mechanism: the lanes intercept contextmenu in CAPTURE phase (Arrangement.tsx) and
// stopPropagation, so the shared ClipView's own (v2-inventory) menu never opens in
// this shell. The menu itself follows ClipView's ClipMenu structure (portal, focus
// the first item, arrow-key nav, outside-dismiss), but Escape goes through the
// shared escape stack — the one discipline ClipMenu predates.

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { useShell } from "../v2/shellState";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { runAction, type ActionCtx } from "../menuActions";
import { pickFiles, pickSaveFile, brainChat } from "../bridge";
import type { Clip } from "../types";
import { useLive } from "./liveState";
import { clampMenuIntoViewport } from "./menuClamp";
import { zoomToFitSpan, currentFitSpan } from "./zoomFit";

export type LiveClipMenuState = { x: number; y: number; clipId: string; time: number };

const actionCtx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat });

export function LiveClipMenu({ menu, onClose }: { menu: LiveClipMenuState; onClose: () => void }) {
  const exec = useStore((s) => s.exec);
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const snapTriplet = useStore((s) => s.snapTriplet);
  const setSnapTriplet = useStore((s) => s.setSnapTriplet);
  const setRenamingClip = useLive((s) => s.setRenamingClip);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (menuRef.current) clampMenuIntoViewport(menuRef.current);
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
  }, []);
  // Outside-pointerdown dismisses; Escape comes from the shared stack (so it can
  // never close this AND an overlay beneath it in one press).
  useLayoutEffect(() => {
    // The escape registration ALSO goes out a tick late: a right-click SELECT can
    // open the docked editor in this same commit (selection-follow), and the editor
    // registers its own Escape handler on mount. Pushing again after the flush
    // moves the MENU on top of the shared stack, so one Escape dismisses the menu,
    // not the editor beneath it. Both pushes are disposed on unmount.
    const disposeImmediate = pushEscapeHandler(onClose);
    let disposeDeferred: (() => void) | null = null;
    const onOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const t = window.setTimeout(() => {
      disposeDeferred = pushEscapeHandler(onClose);
      window.addEventListener("pointerdown", onOutside);
    }, 0);
    return () => {
      disposeImmediate();
      disposeDeferred?.();
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onOutside);
    };
  }, [onClose]);

  const clip: Clip | undefined = snapshot?.tracks
    .flatMap((t) => t.clips)
    .find((c) => c.id === menu.clipId);
  if (!clip) return null;

  // Live's rule: right-clicking a clip INSIDE the multi-selection keeps it (the
  // action hits them all); right-clicking outside it re-selects just that clip. The
  // capture handler in Arrangement already applied this before we opened.
  const selectedClips = (snapshot?.tracks ?? [])
    .flatMap((t) => t.clips)
    .filter((c) => selection.has(c.id));
  // Consolidate works per TYPE (MIDI note-merge or audio render-consolidate);
  // a mixed selection is refused by the engine, so it's disabled here with the reason.
  const consolidateTypes = new Set(selectedClips.map((c) => c.type));
  const canConsolidate = selectedClips.length > 0
    && [...consolidateTypes].every((t) => t === "midi" || t === "wave")
    && consolidateTypes.size === 1;

  // The clip's own track — Freeze/Bounce target it (a clip-level gesture that is a
  // TRACK command in Live). `frozen` flips the Freeze row to Unfreeze (Live's toggle).
  const clipTrack = snapshot?.tracks.find((t) => t.clips.some((c) => c.id === clip.id));

  const run = (fn: () => void) => { fn(); onClose(); };
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[next]?.focus();
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="live-clipmenu"
      role="menu"
      aria-label={`${clip.name} clip actions`}
      data-testid="live-clip-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-zoom-back"
        onClick={() => run(() => {
          const span = useShell.getState().timeRange ?? currentFitSpan();
          if (span) zoomToFitSpan(span);
        })}>
        Zoom Back from Time Selection<kbd>X</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-rename"
        onClick={() => run(() => setRenamingClip(clip.id))}>
        Rename<kbd>⌘R</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-split"
        onClick={() => run(() => void exec("split_clip", { clipId: clip.id, time: menu.time }))}>
        Split<kbd>⌘E</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-consolidate"
        disabled={!canConsolidate}
        title={canConsolidate
          ? (consolidateTypes.has("midi") ? "Merge the selected MIDI clips into one" : "Render the selected audio clips through the track chain into one")
          : "Consolidate needs a same-type selection (MIDI or audio — a mixed set can't merge)"}
        onClick={() => run(() => void runAction("consolidate", actionCtx()))}>
        Consolidate<kbd>⌘J</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-loop"
        onClick={() => run(() => void exec("set_transport", {
          loop: true, loopStart: clip.start, loopEnd: clip.start + clip.length,
        }))}>
        Activate Loop<kbd>⌘L</kbd>
      </button>
      {/* Freeze Track is REAL (freeze_track/unfreeze_track): the clip's track
          renders through its chain and parks its devices; on a frozen track the
          row UNFREEZES — Live's same-row toggle, ⌥⇧⌘F. */}
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-freeze"
        title={clipTrack?.frozen
          ? "Re-enable this track's devices (the rendered audio stays)"
          : "Render this track through its chain, replace its clips with the audio, and park the devices"}
        onClick={() => run(() => void runAction("freeze_track", actionCtx(), { trackId: clipTrack?.id }))}>
        {clipTrack?.frozen ? "Unfreeze Track" : "Freeze Track"}<kbd>⌥⇧⌘F</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-bounce"
        title="Offline-render this clip's track onto a new track below"
        onClick={() => run(() => {
          const trackId = snapshot?.tracks.find((t) => t.clips.some((c) => c.id === clip.id))?.id;
          void runAction("bounce_track", actionCtx(), { trackId });
        })}>
        Bounce to New Track<kbd>⌘B</kbd>
      </button>
      {/* Crop Clip (⇧⌘J) is REAL: the engine trims each selected clip to the drawn
          time selection (notes clipped at the edges, audio offset-adjusts, one undo).
          With no time selection the dispatcher surfaces the honest error. */}
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-crop"
        title="Trim the selected clip(s) to the time selection"
        onClick={() => run(() => void runAction("crop_clip", actionCtx()))}>
        Crop Clip<kbd>⇧⌘J</kbd>
      </button>
      {clip.type === "wave" ? (
        <button role="menuitem" tabIndex={-1} data-testid="live-ctx-reverse"
          onClick={() => run(() => void exec("set_clip_reverse", { clipId: clip.id, reversed: !clip.reversed }))}>
          {clip.reversed ? "Un-reverse Clip" : "Reverse Clip"}<kbd>R</kbd>
        </button>
      ) : (
        <button role="menuitem" tabIndex={-1} disabled data-testid="live-ctx-reverse"
          title="Audio clips only — set_clip_reverse reverses a wave clip's playback">
          Reverse Clip(s)<kbd>R</kbd>
        </button>
      )}
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-mute"
        onClick={() => run(() => void exec("set_clip_mute", { clipId: clip.id, mute: !clip.mute }))}>
        {clip.mute ? "Activate Clip" : "Deactivate Clip"}<kbd>0</kbd>
      </button>

      <div className="live-clipmenu-sep" />
      <div className="live-clipmenu-label" aria-hidden="true">Grid</div>
      <button role="menuitemcheckbox" aria-checked={snap} tabIndex={-1} data-testid="live-ctx-snap"
        onClick={() => run(() => setSnap(!snap))}>
        {snap ? "✓ " : ""}Snap to Grid<kbd>⌘4</kbd>
      </button>
      <button role="menuitemcheckbox" aria-checked={snapTriplet} tabIndex={-1} data-testid="live-ctx-triplet"
        onClick={() => run(() => setSnapTriplet(!snapTriplet))}>
        {snapTriplet ? "✓ " : ""}Triplet Grid<kbd>⌘3</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-narrow"
        onClick={() => run(() => void runAction("grid_narrow", actionCtx()))}>
        Narrow Grid<kbd>⌘1</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-ctx-widen"
        onClick={() => run(() => void runAction("grid_widen", actionCtx()))}>
        Widen Grid<kbd>⌘2</kbd>
      </button>

      <div className="live-clipmenu-sep" />
      <button role="menuitem" tabIndex={-1} className="danger" data-testid="live-ctx-remove"
        onClick={() => run(() => void exec("remove_clip", { clipId: clip.id }))}>
        Remove
      </button>
    </div>,
    document.body,
  );
}
