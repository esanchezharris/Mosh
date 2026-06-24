// The Settings panel — RENDERS ITSELF from the schema. One renderer per setting
// `type`; add a descriptor to schema.ts and it appears here automatically, grouped
// by category. Templates (preset bundles) sit at the top; the user can pick one and
// then override any individual setting on top (template + diffs).
//
// Two intentional exceptions to "schema-driven + local":
//   • Engine (buffer / threads / sample rate / device) — backend state from the
//     snapshot, mutated through its EXISTING MoshOps commands. Not in the schema.
//   • Project (new/save/open/recent) — existing file-management actions, kept as-is.
// Everything else is UI-local and persisted to localStorage via useSettings.

import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";
import type { Snapshot } from "../types";
import { useSettings } from "./store";
import { settingsByCategory, type SettingDef } from "./schema";
import { TEMPLATES } from "./templates";
import { eventToCombo } from "../interaction/keymap";

// ── one renderer per setting type ───────────────────────────────────────────
function SettingControl({ def }: { def: SettingDef }) {
  const raw = useSettings((s) => s.values[def.id]);
  const set = useSettings((s) => s.set);
  const value = raw !== undefined ? raw : def.default;

  switch (def.type) {
    case "enum":
      return (
        <select
          value={String(value)}
          aria-label={def.label}
          onChange={(e) => set(def.id, e.target.value)}
        >
          {(def.constraints?.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );

    case "bool":
      return (
        <button
          className={`btn${value ? " on" : ""}`}
          role="switch"
          aria-checked={Boolean(value)}
          aria-label={def.label}
          onClick={() => set(def.id, !value)}
        >
          {value ? "On" : "Off"}
        </button>
      );

    case "number": {
      const { min, max, step } = def.constraints ?? {};
      const num = Number(value);
      return (
        <span className="set-num">
          <input
            type="range"
            min={min ?? 0}
            max={max ?? 1}
            step={step ?? 0.01}
            value={num}
            aria-label={def.label}
            onChange={(e) => set(def.id, Number(e.target.value))}
          />
          <span className="tc set-num-val">{Math.round(num * 100) / 100}</span>
        </span>
      );
    }

    case "key":
      return (
        <button
          className="btn tc"
          aria-label={def.label}
          title="Click to rebind · right-click to clear"
          onContextMenu={(e) => { e.preventDefault(); set(def.id, ""); }} // clear → inherit preset
          onClick={(e) => {
            const btn = e.currentTarget;
            const onKey = (ev: KeyboardEvent) => {
              // Swallow the capture keypress completely so it can't ALSO fire its live
              // action (the global Arrange keydown listener is on window — without this,
              // rebinding to e.g. Mod+Z would also undo).
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              const combo = eventToCombo(ev);
              if (!combo) return; // lone modifier — keep waiting for the real key
              set(def.id, combo); // store the canonical combo (e.g. "Mod+P")
              window.removeEventListener("keydown", onKey, true);
              btn.classList.remove("on");
            };
            btn.classList.add("on");
            window.addEventListener("keydown", onKey, true);
          }}
        >
          {String(value) || "—"}
        </button>
      );

    case "gesture-table":
    default:
      // Editable gesture/keymap tables are a later phase (templates already reserve
      // the slot); render the current value read-only so nothing crashes if one is added.
      return <span className="pop-note tc">{String(value)} · editor coming soon</span>;
  }
}

function SettingRow({ def }: { def: SettingDef }) {
  return (
    <label className="pop-row" title={def.help}>
      <span>{def.label}</span>
      <SettingControl def={def} />
    </label>
  );
}

// ── template picker (preset bundles) ────────────────────────────────────────
function TemplatePicker() {
  const active = useSettings((s) => s.template);
  const applyTemplate = useSettings((s) => s.applyTemplate);
  const reset = useSettings((s) => s.reset);
  return (
    <div className="pop-group">
      <div className="pop-label">Template</div>
      <div className="pop-actions" data-testid="template-picker">
        {TEMPLATES.map((t) => (
          <button
            key={t.name}
            className={`btn${active === t.name ? " on" : ""}`}
            aria-pressed={active === t.name}
            onClick={() => applyTemplate(t.name)}
          >
            {t.label}
          </button>
        ))}
        <button className="btn" title="Restore default settings" onClick={() => reset()}>Reset</button>
      </div>
      <div className="pop-note">A starting point — override any setting on top.</div>
    </div>
  );
}

// ── backend-owned Engine block — wired to its EXISTING MoshOps commands ──────
function EngineSettings({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const s = snapshot.session;
  return (
    <div className="pop-group">
      <div className="pop-label">Engine</div>
      <div className="pop-row"><span>Device</span><span className="tc">{s.audioDeviceName ?? (s.audioEnabled ? "default" : "—")}</span></div>
      <div className="pop-row"><span>Sample rate</span><span className="tc">{s.sampleRate} Hz</span></div>
      <label className="pop-row"><span>Buffer</span>
        <select value={String(s.bufferSize ?? 512)} onChange={(e) => void exec("set_buffer_size", { bufferSize: Number(e.target.value) }).then(() => refresh())}>
          {[128, 256, 512, 1024].map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </label>
      <label className="pop-row"><span>Threads</span>
        <select value={String(s.audioThreads ?? s.availableCores ?? 8)} onChange={(e) => void exec("set_audio_threads", { threads: Number(e.target.value) }).then(() => refresh())}>
          {Array.from({ length: s.availableCores ?? 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{s.audioThreadsAuto && n === (s.audioThreads ?? n) ? " (auto)" : ""}</option>)}
        </select>
      </label>
    </div>
  );
}

// ── existing Project file-management actions — unchanged ────────────────────
function ProjectSettings({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((st) => st.exec);
  const refresh = useStore((st) => st.refresh);
  const s = snapshot.session;
  return (
    <div className="pop-group">
      <div className="pop-label">Project{s.dirty ? <span className="pop-note" title="Unsaved changes (auto-saved)"> • unsaved</span> : null}</div>
      <div className="pop-actions">
        <button className="btn" onClick={() => void exec("new_project", {}).then(() => refresh())}>New</button>
        <button className="btn" onClick={() => void exec("save", {})}>Save</button>
        <button className="btn" onClick={async () => { const r = await pickSaveFile({ title: "Save project as" }); if (r.ok && r.file) void exec("save_as", { file: r.file }).then(() => refresh()); }}>Save As…</button>
        <button className="btn" onClick={async () => { const r = await pickFiles({ title: "Open project" }); if (r.ok && r.files[0]) void exec("open_project", { file: r.files[0] }).then(() => refresh()); }}>Open…</button>
      </div>
      {(s.recentProjects?.length ?? 0) > 0 && (
        <>
          <div className="pop-label">Recent</div>
          <div className="modal-list" data-testid="recent-projects" style={{ maxHeight: 160 }}>
            {s.recentProjects!.slice(0, 8).map((p, i) => (
              <button key={p.path} className="plugin-row" title={p.path} disabled={p.path === s.editFile}
                      onClick={() => void exec("open_recent", { index: i }).then(() => refresh())}>
                <span className="pr-name">{p.path === s.editFile ? "● " : ""}{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function SettingsPanel({ snapshot }: { snapshot: Snapshot }) {
  const groups = settingsByCategory();
  return (
    <>
      <div className="pop-head">Settings</div>
      <TemplatePicker />
      {groups.map((g) => (
        <div className="pop-group" key={g.category}>
          <div className="pop-label">{g.category}</div>
          {g.settings.map((def) => <SettingRow key={def.id} def={def} />)}
        </div>
      ))}
      <EngineSettings snapshot={snapshot} />
      <ProjectSettings snapshot={snapshot} />
    </>
  );
}

// Re-export so the orphaned-no-more SettingsPanel keeps a single import site.
export default SettingsPanel;
