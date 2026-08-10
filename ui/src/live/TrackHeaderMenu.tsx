// The live shell's TRACK-HEADER context menu (WIDGETS.md §2 ctx-header: Live 12.4's
// right-click on a track header). Freeze Track is REAL (freeze_track/unfreeze_track —
// the row flips to Unfreeze Track on a frozen track, Live's same-row toggle); the
// take-lane rows are omitted entirely (take lanes are a later phase, SPEC §10).
// The Colors section is Live's full 70-swatch radio group (live/trackColors.ts,
// measured) mapping 1:1 onto set_track_color's free "#rrggbb".
//
// Structure mirrors LiveClipMenu (portal, focus-first, arrow nav, escape stack).

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { runAction, type ActionCtx } from "../menuActions";
import { pickFiles, pickSaveFile, brainChat } from "../bridge";
import type { Track } from "../types";
import { useLive } from "./liveState";
import { clampMenuIntoViewport } from "./menuClamp";
import { LIVE_TRACK_COLORS } from "./trackColors";

export type TrackMenuState = { x: number; y: number; trackId: string };

const actionCtx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat });

export function TrackHeaderMenu({ menu, onClose }: { menu: TrackMenuState; onClose: () => void }) {
  const exec = useStore((s) => s.exec);
  const snapshot = useStore((s) => s.snapshot);
  const setRenamingTrack = useLive((s) => s.setRenamingTrack);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (menuRef.current) clampMenuIntoViewport(menuRef.current);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  useLayoutEffect(() => {
    const dispose = pushEscapeHandler(onClose);
    const onOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onOutside), 0);
    return () => {
      dispose();
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onOutside);
    };
  }, [onClose]);

  const track: Track | undefined = snapshot?.tracks.find((t) => t.id === menu.trackId);
  if (!track) return null;

  const run = (fn: () => void) => { fn(); onClose(); };

  return createPortal(
    <div
      ref={menuRef}
      className="live-clipmenu live-trackmenu"
      role="menu"
      aria-label={`${track.name} track actions`}
      data-testid="live-track-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-rename"
        onClick={() => run(() => setRenamingTrack(track.id))}>
        Rename<kbd>⌘R</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-insert-audio"
        onClick={() => run(() => void runAction("insert_audio_track", actionCtx()))}>
        Insert Audio Track<kbd>⌘T</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-insert-midi"
        onClick={() => run(() => void runAction("insert_midi_track", actionCtx()))}>
        Insert MIDI Track<kbd>⇧⌘T</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-group"
        onClick={() => run(() => void exec("create_group_track", { trackIds: [track.id] }))}>
        Group Tracks<kbd>⌘G</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-bounce-inplace"
        title="Offline-render this track's output and replace its clips with the audio (devices stay)"
        onClick={() => run(() => void runAction("bounce_track", actionCtx(), { mode: "inPlace", trackId: track.id }))}>
        Bounce Track in Place
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-bounce-new"
        title="Offline-render this track's output onto a new track below (source untouched)"
        onClick={() => run(() => void runAction("bounce_track", actionCtx(), { trackId: track.id }))}>
        Bounce to New Track<kbd>⌘B</kbd>
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-tm-freeze"
        title={track.frozen
          ? "Re-enable this track's devices (the rendered audio stays; undo the freeze itself to restore the original clips)"
          : "Render this track through its chain, replace its clips with the audio, and park the devices"}
        onClick={() => run(() => void runAction("freeze_track", actionCtx(), { trackId: track.id }))}>
        {track.frozen ? "Unfreeze Track" : "Freeze Track"}<kbd>⌥⇧⌘F</kbd>
      </button>

      <div className="live-clipmenu-sep" />
      <div className="live-clipmenu-label" aria-hidden="true">Colors</div>
      <div className="live-swatches" role="radiogroup" aria-label="Track color">
        {LIVE_TRACK_COLORS.map((c, i) => (
          <button
            key={`${c.name}-${i}`}
            role="radio"
            aria-checked={(track.color ?? "") === c.hex}
            aria-label={c.name}
            title={c.name}
            data-testid="live-swatch"
            className={`live-swatch${(track.color ?? "") === c.hex ? " on" : ""}`}
            style={{ background: c.hex }}
            onClick={() => run(() => void exec("set_track_color", { trackId: track.id, color: c.hex }))}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
