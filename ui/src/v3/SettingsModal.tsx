import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useSettings } from "../settings/store";
import { settingsByCategory, type SettingDef } from "../settings/schema";
import { settingHiddenForShell } from "../settings/shellVisibility";
import { EngineSettings, AudioRouting, ProjectSettings } from "../settings/SettingsPanel";
import { activeShell } from "../v2/shellFlag";
import type { Snapshot } from "../types";
import { useV3 } from "./shellState";
import { colorwayAttr } from "./colorway";

const SWATCHES = [
  { key: "lime", hex: "#C6F542", label: "Lime" },
  { key: "bone", hex: "#E8E2D6", label: "Bone" },
  { key: "violet", hex: "#B8A4FF", label: "Violet" },
  { key: "coral", hex: "#FF8B7A", label: "Coral" },
] as const;

const CUSTOM = new Set(["colorway", "agentConfirmDestructive"]);
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function SettingControl({ def }: { def: SettingDef }) {
  const raw = useSettings((s) => s.get(def.id));
  const set = useSettings((s) => s.set);
  if (def.type === "bool") {
    return (
      <button type="button" className="btn sm" onClick={() => set(def.id, !raw)}>
        {raw ? "On" : "Off"}
      </button>
    );
  }
  if (def.type === "enum") {
    return (
      <select value={String(raw)} onChange={(e) => set(def.id, e.target.value)}>
        {(def.constraints?.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (def.type === "number") {
    return (
      <input type="number" value={Number(raw)} min={def.constraints?.min} max={def.constraints?.max}
        step={def.constraints?.step}
        onChange={(e) => set(def.id, Number(e.target.value))} />
    );
  }
  return <span className="val">{String(raw)}</span>;
}

export function SettingsModal({ snapshot }: { snapshot: Snapshot }) {
  const open = useV3((s) => s.settingsOpen);
  const setOpen = useV3((s) => s.setSettingsOpen);
  const colorway = colorwayAttr(useSettings((s) => s.get("colorway")));
  const set = useSettings((s) => s.set);
  const confirm = Boolean(useSettings((s) => s.get("agentConfirmDestructive")));
  const shell = activeShell();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useEscapeToClose(open, close);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [open]);
  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((control) => !control.closest("[hidden], [inert]"));
    const first = controls[0];
    const last = controls.at(-1);
    const active = document.activeElement;
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  const groups = settingsByCategory()
    .map((g) => ({
      ...g,
      settings: g.settings.filter((d) => !settingHiddenForShell(shell, g.category, d.id) && !CUSTOM.has(d.id)),
    }))
    .filter((g) => g.settings.length > 0);

  if (!open) return null;
  const session = snapshot.session;

  return (
    <div className="modal-root" data-settings data-testid="v3-settings">
      <div className="scrim" onClick={close} />
      <div ref={dialogRef} className="modal glass" role="dialog" aria-label="Settings" aria-modal="true"
        tabIndex={-1} onKeyDown={trapFocus}>
        <div className="modal-hd">
          <b>Settings</b>
          <button ref={closeRef} type="button" className="icon-x" aria-label="Close" onClick={close}>×</button>
        </div>
        <div className="modal-body">
          <div className="set-sec">
            <div className="set-label">Colorway</div>
            <p className="set-hint">Accent for selection, MIDI notes, and primary actions. Session content stays bone.</p>
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button key={c.key} type="button" className={`swatch${colorway === c.key ? " on" : ""}`}
                  data-testid="v3-colorway" data-colorway={c.key} style={{ ["--sw" as string]: c.hex }}
                  onClick={() => set("colorway", c.key)}>
                  <i /><span>{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="set-sec">
            <div className="set-label">Session</div>
            <div className="set-row"><span>Sample rate</span><span className="val">{session.sampleRate} Hz</span></div>
            <label className="set-row"><span>Buffer</span>
              <select value={String(session.bufferSize ?? 512)}
                onChange={(e) => void useStore.getState().exec("set_buffer_size", { bufferSize: Number(e.target.value) }).then(() => useStore.getState().refresh())}>
                {[128, 256, 512, 1024].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          </div>

          <div className="set-sec">
            <div className="set-label">Agent</div>
            <div className="set-row"><span>Moshi</span><span className="val">Optional assistant</span></div>
            <label className="set-row"><span>Confirm destructive</span>
              <button type="button" className="btn sm" data-testid="v3-confirm-destructive"
                onClick={() => set("agentConfirmDestructive", !confirm)}>
                {confirm ? "Ask" : "Off"}
              </button>
            </label>
          </div>

          <EngineSettings snapshot={snapshot} />
          <AudioRouting snapshot={snapshot} />
          <ProjectSettings snapshot={snapshot} />

          {groups.map((g) => (
            <div className="set-sec" key={g.category}>
              <div className="set-label">{g.category}</div>
              {g.settings.map((def) => (
                <label className="set-row" key={def.id} title={def.help}>
                  <span>{def.label}</span>
                  <SettingControl def={def} />
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
