import { useEffect, useState } from "react";
import { useStore } from "../store";
import { SampleBrowser } from "../ui/SampleBrowser";
import { PluginDock } from "../v2/PluginBrowser";
import type { DirListing } from "../types";
import { useV3 } from "./shellState";

function MidiBrowser() {
  const exec = useStore((s) => s.exec);
  const [listing, setListing] = useState<DirListing | null>(null);
  useEffect(() => {
    void exec("list_directory", {}).then((r) => {
      if (r.ok && r.data) setListing(r.data as DirListing);
    });
  }, [exec]);
  const midi = (listing?.entries ?? []).filter((e) => /\.(mid|midi)$/i.test(e.name));
  return (
    <div className="pane-list" data-testid="v3-midi-browser">
      {midi.length === 0 && <div className="set-hint" style={{ padding: 10 }}>No MIDI files in this folder.</div>}
      {midi.map((e) => (
        <div key={e.path} className="br-row">{e.name}</div>
      ))}
    </div>
  );
}

export function BrowserPane() {
  const tab = useV3((s) => s.browserTab);
  const setTab = useV3((s) => s.setBrowserTab);
  return (
    <aside className="side-pane" data-testid="v3-browser">
      <div className="pane-hd">
        <span className="sec">Browser</span>
        <span className="pane-tabs">
          <button type="button" className={tab === "files" ? "on" : ""} data-testid="v3-browser-files" onClick={() => setTab("files")}>Files</button>
          <button type="button" className={tab === "midi" ? "on" : ""} data-testid="v3-browser-midi" onClick={() => setTab("midi")}>MIDI</button>
          <button type="button" className={tab === "presets" ? "on" : ""} data-testid="v3-browser-presets" onClick={() => setTab("presets")}>Presets</button>
        </span>
      </div>
      {tab === "files" && <div className="pane-list"><SampleBrowser /></div>}
      {tab === "midi" && <MidiBrowser />}
      {tab === "presets" && (
        <div className="pane-list" data-testid="v3-presets">
          <p className="set-hint" style={{ padding: 10 }}>FX presets — browse only. Not an Inspector FX tab.</p>
          <PluginDock />
        </div>
      )}
    </aside>
  );
}
