import { useEffect, useState } from "react";
import { useStore } from "./store";
import { isNative } from "./bridge";
import { Arrangement } from "./components/Arrangement";
import { Transport, AudioOut, AudioIn } from "./components/Transport";
import { Rack } from "./components/Rack";
import { PluginBrowser } from "./components/PluginBrowser";
import { TutorialBar } from "./components/TutorialBar";
import { CollabPanel } from "./components/CollabPanel";
import { AgentPanel } from "./components/AgentPanel";
import { CrateBrowser } from "./components/CrateBrowser";

// Stage 1 UI: renders the MoshOps snapshot cold, drives every mutation through
// execute_command, and reacts to the snapshot+events feed. Deliberately thin and
// conventional — Stage 2 grows this into the full arrangement (drag/trim/split,
// zoom/snap, marquee). The backend has zero knowledge of any of it (swappable seam).
// Global DAW keyboard (Stage 15). Same input-guard as the TutorialBar hotkey:
// never fire while typing.
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
        return;
      const s = useStore.getState();
      if (e.code === "Space") {
        e.preventDefault();
        void s.exec("set_transport", { action: "toggle" });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (s.editingClipId) return;          // the piano roll owns delete while open
        if (s.selection.size === 0) return;
        e.preventDefault();
        for (const id of s.selection) void s.exec("remove_clip", { clipId: id });
        s.clearSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void s.exec(e.shiftKey ? "redo" : "undo", {});
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        if (s.editingClipId || s.selection.size === 0) return;
        e.preventDefault();
        s.setClipClipboard([...s.selection]);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (s.editingClipId || s.clipClipboard.length === 0) return;
        e.preventDefault();
        const at = s.snapshot?.transport.position ?? 0;
        for (const id of s.clipClipboard)
          void s.exec("duplicate_clip", { clipId: id, startSeconds: at });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        if (s.editingClipId || s.selection.size === 0) return;
        e.preventDefault();
        for (const id of s.selection) void s.exec("duplicate_clip", { clipId: id });
      } else if (e.key === "=" || e.key === "+") {
        s.setPxPerSec(s.pxPerSec * 1.4);
      } else if (e.key === "-") {
        s.setPxPerSec(s.pxPerSec / 1.4);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function CrateToggleArea({ snapshot }: { snapshot: NonNullable<ReturnType<typeof useStore.getState>["snapshot"]> }) {
  const crateOpen = useStore((s) => s.crateOpen);
  if (!crateOpen) return null;
  return <CrateBrowser snapshot={snapshot} />;
}

// Project menu (Stage 26): save-as + open, copy-based local projects.
function ProjectMenu() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const [projects, setProjects] = useState<string[] | null>(null);
  const [savingAs, setSavingAs] = useState(false);
  const current = snapshot?.session.projectName || "untitled";

  const load = async () => {
    const res = await exec("list_projects", {});
    const data = res.data as { projects?: string[] } | undefined;
    if (res.ok && data?.projects) setProjects(data.projects);
  };

  if (savingAs)
    return (
      <input
        className="tutorial-input proj-input"
        autoFocus
        placeholder="project name…"
        onBlur={(e) => {
          const name = e.target.value.trim();
          setSavingAs(false);
          if (name) void exec("save_project_as", { name });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setSavingAs(false);
        }}
      />
    );

  return (
    <select
      className="ao-select proj-menu"
      value=""
      title={`Project: ${current}`}
      onPointerDown={() => projects == null && void load()}
      onChange={(e) => {
        const v = e.target.value;
        e.target.value = "";
        if (v === "__saveas") setSavingAs(true);
        else if (v) void exec("open_project", { name: v });
      }}
    >
      <option value="" disabled>▤ {current}</option>
      <option value="__saveas">save as…</option>
      {(projects ?? []).filter((pn) => pn !== current).map((pn) => (
        <option key={pn} value={pn}>open: {pn}</option>
      ))}
    </select>
  );
}

function CrateToggle() {
  const crateOpen = useStore((s) => s.crateOpen);
  const setCrateOpen = useStore((s) => s.setCrateOpen);
  return (
    <button
      className={`tool-btn ${crateOpen ? "on" : ""}`}
      title="Crate — browse + audition the sample library"
      onClick={() => setCrateOpen(!crateOpen)}
    >
      🗄 Crate
    </button>
  );
}

function MixerToggle() {
  const mixerOpen = useStore((s) => s.mixerOpen);
  const setMixerOpen = useStore((s) => s.setMixerOpen);
  const setEditingClip = useStore((s) => s.setEditingClip);
  return (
    <button
      className={`tool-btn ${mixerOpen ? "on" : ""}`}
      title="Mixer — sends, routing, faders"
      onClick={() => {
        setEditingClip(null);
        setMixerOpen(!mixerOpen);
      }}
    >
      ☰ Mixer
    </button>
  );
}

export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const exec = useStore((s) => s.exec);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const [warningDismissed, setWarningDismissed] = useState(false);

  useEffect(() => {
    init();
  }, [init]);
  useGlobalKeys();

  if (!isNative()) {
    return (
      <div className="boot">
        <h2>Mosh</h2>
        <p>Running outside the JUCE WebView (pure-web dev). Launch the Mosh app
        to drive the engine.</p>
      </div>
    );
  }

  return (
    <div className="daw">
      <header className="topbar">
        <div className="brand-min">
          <span className="logo-min">M</span> Mosh
          <ProjectMenu />
        </div>
        <Transport />
        <div className="topbar-right">
          {/* Git-style async session sync (Stage 10). */}
          <CollabPanel />
          {/* Tutorial-replication tooling (phase0 s6): URL + markers + consent. */}
          <TutorialBar />
          {/* B-5 / Monster — the producer agent (Stage 11, phase0 s10). */}
          <AgentPanel />
          {/* Audio-output truth (Stage 14): show + switch the device. */}
          <AudioOut />
          <AudioIn />
          <MixerToggle />
          <CrateToggle />
          <button className="tool-btn" onClick={() => exec("export_audio", {})} title="Export the mix (WAV 24-bit 48k)">
            ⤓ Export
          </button>
          <select
            className="ao-select"
            value=""
            title="Export options (Stage 21)"
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = "";
              if (v === "wav24-48") void exec("export_audio", { bitDepth: 24, sampleRate: 48000 });
              else if (v === "wav16-44") void exec("export_audio", { bitDepth: 16, sampleRate: 44100 });
              else if (v === "loop24-48") void exec("export_audio", { bitDepth: 24, sampleRate: 48000, loopOnly: true });
              else if (v === "loop16-44") void exec("export_audio", { bitDepth: 16, sampleRate: 44100, loopOnly: true });
              else if (v === "stems") void exec("export_audio", { stems: true, bitDepth: 24, sampleRate: 48000 });
              else if (v === "mp3") void exec("export_audio", { bitDepth: 24, sampleRate: 48000, format: "mp3" });
              else if (v === "m4a") void exec("export_audio", { bitDepth: 24, sampleRate: 48000, format: "m4a" });
            }}
          >
            <option value="" disabled>⚙</option>
            <option value="wav24-48">full · 24-bit 48k</option>
            <option value="wav16-44">full · 16-bit 44.1k</option>
            <option value="loop24-48">loop · 24-bit 48k</option>
            <option value="loop16-44">loop · 16-bit 44.1k</option>
            <option value="stems">stems · 24-bit 48k</option>
            <option value="mp3">mp3 · 320k</option>
            <option value="m4a">m4a · AAC</option>
          </select>
          <button className="tool-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {lastError && <div className="error-bar">⚠ {lastError}</div>}
      {snapshot?.session.audioWarning && !warningDismissed && (
        <div className="warn-bar">
          ⚠ {snapshot.session.audioWarning}
          <button className="mini" onClick={() => setWarningDismissed(true)}>✕</button>
        </div>
      )}

      {snapshot ? (
        <div className="main-row">
          <CrateToggleArea snapshot={snapshot} />
          <div className="main-col">
            <Arrangement snapshot={snapshot} />
            <Rack snapshot={snapshot} />
          </div>
        </div>
      ) : (
        <div className="boot"><p>Loading snapshot…</p></div>
      )}

      <PluginBrowser />
    </div>
  );
}
