// The device strip (WIDGETS §2 device-view) — the selected track's plugin chain as
// a horizontal strip of chips. Gestures (Live's device view):
//   click          = select the chip (visible state; Delete/Backspace removes it)
//   double-click   = open the plugin's editor (open_plugin_editor)
//   ⏻              = bypass toggle (bypass_plugin)
//   right-click    = chip menu (Open editor / Bypass / Remove)
// Removal is remove_plugin through the same seam; the Delete handling lives on the
// chip's OWN keydown (focus-scoped), so it can never fight the editor's Delete.

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { MoshTip } from "../chrome/Tooltip";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { clampMenuIntoViewport } from "./menuClamp";
import type { Track } from "../types";

export function DeviceStrip({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const plugins = track.plugins ?? [];
  const [selIndex, setSelIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);

  if (plugins.length === 0) {
    return (
      <div className="live-devices" data-testid="live-devices">
        <span className="live-devices-empty" role="status">No devices — load one from the browser.</span>
      </div>
    );
  }

  const remove = (index: number) => void exec("remove_plugin", { trackId: track.id, index });

  return (
    <div className={`live-devices${track.frozen ? " frozen" : ""}`} data-testid="live-devices" role="group"
      aria-label={`Devices on ${track.name}`} data-frozen={track.frozen === true}
      title={track.frozen ? "Track is frozen — devices are parked (zero CPU) until you unfreeze (⌥⇧⌘F)" : undefined}>
      {track.frozen && <span className="live-devices-frozen" role="status">Frozen</span>}
      {plugins.map((p) => (
        <span
          key={p.index}
          className={`live-device${p.enabled ? "" : " off"}${selIndex === p.index ? " sel" : ""}`}
          data-testid="live-device"
          data-plugin-index={p.index}
          data-selected={selIndex === p.index}
          role="button"
          tabIndex={0}
          aria-label={`${p.name} device`}
          aria-pressed={selIndex === p.index}
          onClick={() => setSelIndex(p.index)}
          onDoubleClick={() => void exec("open_plugin_editor", { trackId: track.id, index: p.index })}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelIndex(p.index);
            setMenu({ x: e.clientX, y: e.clientY, index: p.index });
          }}
          onKeyDown={(e) => {
            // Focus-scoped: only a FOCUSED chip answers Delete/Backspace — the docked
            // editor's own Delete (notes) is untouched by construction.
            if (track.frozen) return;   // frozen track: the chain is parked, not editable
            if (e.key !== "Delete" && e.key !== "Backspace") return;
            e.preventDefault();
            e.stopPropagation();
            remove(p.index);
            setSelIndex(null);
          }}
        >
          <span className="live-device-name" data-testid="live-device-open">{p.name}</span>
          <MoshTip side="top" label={p.enabled ? `Bypass ${p.name}` : `${p.name} is bypassed — click to enable`}>
            <button
              className="live-device-bypass"
              data-testid="live-device-bypass"
              aria-label={`Bypass ${p.name}`}
              aria-pressed={!p.enabled}
              onClick={(e) => { e.stopPropagation(); void exec("bypass_plugin", { trackId: track.id, index: p.index, bypassed: p.enabled }); }}
            >⏻</button>
          </MoshTip>
        </span>
      ))}
      {menu && (
        <DeviceChipMenu
          track={track}
          menu={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function DeviceChipMenu({ track, menu, onClose }: {
  track: Track;
  menu: { x: number; y: number; index: number };
  onClose: () => void;
}) {
  const exec = useStore((s) => s.exec);
  const menuRef = useRef<HTMLDivElement>(null);
  const p = (track.plugins ?? []).find((x) => x.index === menu.index);
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
  if (!p) return null;
  const run = (fn: () => void) => { fn(); onClose(); };

  return createPortal(
    <div
      ref={menuRef}
      className="live-clipmenu"
      role="menu"
      aria-label={`${p.name} device actions`}
      data-testid="live-device-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button role="menuitem" tabIndex={-1} data-testid="live-device-menu-open"
        onClick={() => run(() => void exec("open_plugin_editor", { trackId: track.id, index: p.index }))}>
        Open editor
      </button>
      <button role="menuitem" tabIndex={-1} data-testid="live-device-menu-bypass"
        onClick={() => run(() => void exec("bypass_plugin", { trackId: track.id, index: p.index, bypassed: p.enabled }))}>
        {p.enabled ? "Bypass" : "Un-bypass"}
      </button>
      <button role="menuitem" tabIndex={-1} className="danger" data-testid="live-device-menu-remove"
        onClick={() => run(() => void exec("remove_plugin", { trackId: track.id, index: p.index }))}>
        Remove<kbd>Del</kbd>
      </button>
    </div>,
    document.body,
  );
}
