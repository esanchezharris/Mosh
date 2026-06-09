import { useMemo, useState } from "react";
import { useStore } from "../store";

// Modal plugin browser (Stage 3). Lists scanned VST3s (list_plugins) and loads
// the chosen one onto the selected track (load_plugin).
export function PluginBrowser() {
  const open = useStore((s) => s.browserOpen);
  const close = useStore((s) => s.closeBrowser);
  const plugins = useStore((s) => s.availablePlugins);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "inst" | "fx">("all");

  const filtered = useMemo(
    () =>
      plugins.filter((p) => {
        if (kind === "inst" && !p.isInstrument) return false;
        if (kind === "fx" && p.isInstrument) return false;
        return q === "" || p.name.toLowerCase().includes(q.toLowerCase());
      }),
    [plugins, q, kind]
  );

  if (!open) return null;

  const load = (id: string) => {
    if (selectedTrackId) void exec("load_plugin", { trackId: selectedTrackId, pluginId: id });
    close();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Add plugin</strong>
          <button className="x" onClick={close}>✕</button>
        </div>
        <div className="modal-filters">
          <input autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>All</button>
          <button className={kind === "inst" ? "on" : ""} onClick={() => setKind("inst")}>Instruments</button>
          <button className={kind === "fx" ? "on" : ""} onClick={() => setKind("fx")}>Effects</button>
        </div>
        <div className="modal-list">
          {filtered.length === 0 && <div className="rack-empty">no plugins scanned</div>}
          {filtered.map((p) => (
            <button key={p.id} className="plugin-row" onClick={() => load(p.id)}>
              <span className="pr-name">{p.name}</span>
              <span className="pr-meta">
                {p.isInstrument ? "instrument" : "effect"} · {p.manufacturer || p.format}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
