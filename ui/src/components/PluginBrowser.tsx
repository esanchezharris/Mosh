import { useMemo, useState } from "react";
import { useStore } from "../store";

// Modal plugin browser (Stage 3 + Wave 1). Lists the engine's built-in palette
// (instruments + effects, load_builtin) grouped by category, plus scanned
// VST3/AUs (list_plugins → load_plugin) onto the selected track.
export function PluginBrowser() {
  const open = useStore((s) => s.browserOpen);
  const close = useStore((s) => s.closeBrowser);
  const plugins = useStore((s) => s.availablePlugins);
  const builtins = useStore((s) => s.availableBuiltins);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "inst" | "fx">("all");

  const matches = (name: string, isInstrument: boolean) => {
    if (kind === "inst" && !isInstrument) return false;
    if (kind === "fx" && isInstrument) return false;
    return q === "" || name.toLowerCase().includes(q.toLowerCase());
  };

  const filteredBuiltins = useMemo(
    () => builtins.filter((b) => matches(b.name, b.isInstrument)),
    [builtins, q, kind]
  );
  const filtered = useMemo(
    () => plugins.filter((p) => matches(p.name, p.isInstrument)),
    [plugins, q, kind]
  );

  // Group built-ins by category, preserving the catalog order.
  const byCategory = useMemo(() => {
    const map = new Map<string, typeof filteredBuiltins>();
    for (const b of filteredBuiltins) {
      const arr = map.get(b.category) ?? [];
      arr.push(b);
      map.set(b.category, arr);
    }
    return [...map.entries()];
  }, [filteredBuiltins]);

  if (!open) return null;

  const loadVst = (id: string) => {
    if (selectedTrackId) void exec("load_plugin", { trackId: selectedTrackId, pluginId: id });
    close();
  };
  const loadBuiltin = (type: string) => {
    if (selectedTrackId) void exec("load_builtin", { trackId: selectedTrackId, type });
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
          {byCategory.map(([cat, items]) => (
            <div className="plugin-group" key={cat}>
              <div className="pg-label">{cat}</div>
              {items.map((b) => (
                <button key={b.type} className="plugin-row" onClick={() => loadBuiltin(b.type)}>
                  <span className="pr-name">{b.name}</span>
                  <span className="pr-meta">
                    {b.isInstrument ? "instrument" : "effect"} · built-in
                  </span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length > 0 && (
            <div className="plugin-group">
              <div className="pg-label">Installed (VST3 / AU)</div>
              {filtered.map((p) => (
                <button key={p.id} className="plugin-row" onClick={() => loadVst(p.id)}>
                  <span className="pr-name">{p.name}</span>
                  <span className="pr-meta">
                    {p.isInstrument ? "instrument" : "effect"} · {p.manufacturer || p.format}
                  </span>
                </button>
              ))}
            </div>
          )}
          {byCategory.length === 0 && filtered.length === 0 && (
            <div className="rack-empty">nothing matches “{q}”</div>
          )}
        </div>
      </div>
    </div>
  );
}
