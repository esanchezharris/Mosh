// Modal plugin browser: engine built-ins (grouped by category, load_builtin) +
// scanned VST3/AU (load_plugin) onto the selected track. Filter + kind tabs.

import { useMemo, useState } from "react";
import { useStore } from "../store";

export function PluginBrowser() {
  const open = useStore((s) => s.browserOpen);
  const close = useStore((s) => s.closeBrowser);
  const plugins = useStore((s) => s.availablePlugins);
  const builtins = useStore((s) => s.availableBuiltins);
  const counts = useStore((s) => s.pluginCounts);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const rescanPlugins = useStore((s) => s.rescanPlugins);
  const scanProgress = useStore((s) => s.scanProgress);
  const scanning = scanProgress != null && !scanProgress.done;
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "inst" | "fx">("all");

  const matches = (name: string, isInstrument: boolean) => {
    if (kind === "inst" && !isInstrument) return false;
    if (kind === "fx" && isInstrument) return false;
    return q === "" || name.toLowerCase().includes(q.toLowerCase());
  };
  const fBuiltins = useMemo(() => builtins.filter((b) => matches(b.name, b.isInstrument)), [builtins, q, kind]);
  const fVst = useMemo(() => plugins.filter((p) => matches(p.name, p.isInstrument)), [plugins, q, kind]);
  const byCategory = useMemo(() => {
    const m = new Map<string, typeof fBuiltins>();
    for (const b of fBuiltins) { const a = m.get(b.category) ?? []; a.push(b); m.set(b.category, a); }
    return [...m.entries()];
  }, [fBuiltins]);

  if (!open) return null;
  const loadBuiltin = (type: string) => { if (selectedTrackId) void exec("load_builtin", { trackId: selectedTrackId, type }); close(); };
  const loadVst = (id: string) => { if (selectedTrackId) void exec("load_plugin", { trackId: selectedTrackId, pluginId: id }); close(); };

  return (
    <div className="modal-backdrop" onClick={close} data-testid="plugin-browser">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="display">Add plugin</strong>
          <span className="pr-meta tc">{counts ? `${counts.vst3} VST3 · ${counts.au} AU` : `${plugins.length} installed`}</span>
          <button className="btn ghost" onClick={() => void rescanPlugins("vst3")} disabled={scanning}
            title="Re-scan the installed VST3 folders">{scanning ? "Scanning…" : "Rescan"}</button>
          <button className="btn x" onClick={close}>✕</button>
        </div>
        <div className="modal-filters">
          <input autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          {(["all", "inst", "fx"] as const).map((k) => (
            <button key={k} className={`btn${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{k === "all" ? "All" : k === "inst" ? "Instruments" : "Effects"}</button>
          ))}
        </div>
        <div className="modal-list">
          {byCategory.map(([cat, items]) => (
            <div className="plugin-group" key={cat}>
              <div className="pg-label">{cat}</div>
              {items.map((b) => (
                <button key={b.type} className="plugin-row" onClick={() => loadBuiltin(b.type)}>
                  <span className="pr-name">{b.name}</span>
                  <span className="pr-meta">{b.isInstrument ? "instrument" : "effect"} · built-in</span>
                </button>
              ))}
            </div>
          ))}
          {fVst.length > 0 && (
            <div className="plugin-group">
              <div className="pg-label">Installed (VST3 / AU)</div>
              {fVst.map((p) => (
                <button key={p.id} className="plugin-row" onClick={() => loadVst(p.id)}>
                  <span className="pr-name">{p.name}</span>
                  <span className="pr-meta">{p.isInstrument ? "instrument" : "effect"} · {p.format}{p.manufacturer ? ` · ${p.manufacturer}` : ""}</span>
                </button>
              ))}
            </div>
          )}
          {byCategory.length === 0 && fVst.length === 0 && <div className="rack-empty">nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  );
}
