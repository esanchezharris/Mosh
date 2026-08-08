// CAP-TB-001 / #633 — the audio OUTPUT DEVICE, named in the transport bar.
//
// Why this exists at all: on 2026-08-05 the owner sat in front of Mosh with headphones
// plugged in, heard the laptop speakers, and could not work out why — because NOTHING in
// the shipped shell said which device was in use. The Inspector's "Out: out_…" is TRACK
// routing and reads like the answer while being a different thing entirely. The engine
// was behaving correctly (it restores the device you last chose, like every other DAW);
// the failure was purely that it never said so. See #632 for that distinction.
//
// So the requirement is not "add a picker" — one already existed, buried behind a `+` in
// the chat composer (#634). The requirement is that the device NAME is readable without
// opening anything. Hence a chip that shows it, and only opens a list when clicked.
//
// The name comes from `snapshot.session.audioDeviceName`, which the snapshot has carried
// all along — so this is UI-only, no engine change.
//
// The device LIST is fetched lazily, on click, and never at mount. That is deliberate and
// load-bearing: execute_command is synchronous on the UI thread, so an enumeration issued
// during render would stall the shell on every launch. Fetching on open costs one frame
// the user asked for.
import { useState } from "react";
import type { AudioDevices, Snapshot } from "../types";
import { useStore } from "../store";
import { useAnchoredPanel } from "../hooks/useAnchoredPanel";

/** The engine's sentinel for "whatever the system hands us" — not a real device name. */
const DEFAULT_SENTINEL = "(default audio output)";

/** MUST match the `width` pinned on .v2-outdev-pop — useAnchoredPanel clamps against this
 *  number, so a panel that renders wider than it declares gets placed wrong on a narrow
 *  window. Same contract (and same past bug) as .v2-rec-panel and .v2-click-panel. */
const kPanelWidth = 260;

export function AudioOutputChip() {
  const snapshot = useStore((s) => s.snapshot) as Snapshot | null;
  const exec = useStore((s) => s.exec);
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [busy, setBusy] = useState(false);

  // The list is rendered `position: fixed` against the trigger's client rect rather than
  // absolutely inside the chip, and that is load-bearing rather than tidiness: the chip
  // sits in `.v2-proj-meta`, which is `overflow-x: auto` as its floor safety net, and an
  // absolutely-positioned child of an overflow ancestor is CLIPPED — the chip would look
  // inert while opening into a hidden box. Fixed + viewport-clamped is the answer the
  // overflow, add-track and record panels already use. It also brings Escape handling,
  // capture-phase outside-dismiss and the one-frame-late scroll arming for free, all of
  // which this component previously hand-rolled (and the scroll one it lacked entirely).
  const { open, at, anchorRef, panelRef, toggle, close } = useAnchoredPanel(kPanelWidth, 320, "start");

  const name = snapshot?.session?.audioDeviceName ?? "";
  const error = snapshot?.session?.audioDeviceError ?? "";
  const sysDefault = snapshot?.session?.audioDeviceSystemDefault ?? "";
  const audioOff = snapshot?.session?.audioEnabled === false;

  // Lazily, on open — see the note at the top about the synchronous bridge.
  const openList = async () => {
    toggle();
    if (devices || busy) return;
    setBusy(true);
    try {
      const r = await exec("list_audio_devices", {});
      if (r?.ok) setDevices(r.data as AudioDevices);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (outputName: string) => {
    close();
    await exec("set_audio_device", { outputDevice: outputName });
  };

  // What to SHOW. An empty name means the engine is on the unnamed default, which is a
  // real state and must not render as a blank chip.
  const label = audioOff ? "No audio" : (name || DEFAULT_SENTINEL);
  const outputs = devices?.types?.flatMap((t) => t.outputs) ?? [];

  // #632 — the hint. Mosh RESTORES your last-chosen device rather than following the
  // system, which is correct and matches other DAWs. This is the part that was missing:
  // saying so, when the two have drifted apart. Suppressed when the default is unknown
  // (nothing has enumerated yet) or when we are already on it — a hint that fires on the
  // happy path is noise, and noise gets ignored right when it finally matters.
  const driftedFromDefault =
    !audioOff && !!name && !!sysDefault && name !== sysDefault;

  return (
    <div className="v2-outdev">
      <button
        ref={anchorRef}
        className="v2-chip v2-outdev-btn"
        data-testid="v2-output-device"
        data-audio-off={audioOff || undefined}
        data-error={error ? true : undefined}
        data-drifted={driftedFromDefault || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={driftedFromDefault
          ? `Audio output: ${label}. Your Mac's default is ${sysDefault}. Click to change.`
          : `Audio output: ${label}. Click to change.`}
        title={error
          ? `Audio output: ${label} — ${error}`
          : audioOff
            ? "No audio device is open — playback and recording are off. Click to choose one."
            : driftedFromDefault
              ? `Audio output: ${label}. Your Mac's default is "${sysDefault}" — Mosh keeps the device you last chose. Click to switch.`
              : `Audio output: ${label}. Click to change.`}
        onClick={() => void openList()}
      >
        <span className="v2-outdev-name">{label}</span>
        {driftedFromDefault && <span className="v2-outdev-drift" aria-hidden="true">•</span>}
      </button>
      {/* `at` gates the render: the panel is fixed-position and its CSS clears top/right,
          so the inline style MUST supply left + one of top/bottom or it falls to static
          position. Same contract as the overflow and add-track menus. */}
      {open && at && (
        <div ref={panelRef} className="pop v2-outdev-pop" role="listbox" aria-label="Audio output device"
          style={{ left: at.left, top: at.top, bottom: at.bottom }}>
          {driftedFromDefault && (
            <button className="v2-outdev-item v2-outdev-default" onClick={() => void pick(sysDefault)}>
              Use your Mac's default — {sysDefault}
            </button>
          )}
          {busy && <div className="v2-outdev-empty">Finding devices…</div>}
          {!busy && outputs.length === 0 && (
            <div className="v2-outdev-empty">No output devices found.</div>
          )}
          {outputs.map((o) => (
            <button
              key={o}
              role="option"
              aria-selected={o === name}
              className="v2-outdev-item"
              data-on={o === name || undefined}
              title={o}
              onClick={() => void pick(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
