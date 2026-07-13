import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Grid } from "./judging/Grid";
import { AvsB } from "./judging/AvsB";
import { Tuner } from "./judging/Tuner";
import { Lightbox } from "./judging/Lightbox";
import { GeneratePanel } from "./judging/GeneratePanel";
import { arena, computeVisible, designerLabel, useArena } from "./library/store";
import { getMeter, type Meter } from "./models/client";
import { transport } from "./harness/transport";
import { TARGETS, type Candidate, type Target } from "./models/types";
import { MODE_NAMES } from "./kit/fixtures";

const DENSITY: Record<string, string> = { S: "280px", M: "360px", L: "520px" };

export function App() {
  const view = useArena((s) => s.view);
  const mode = useArena((s) => s.mode);
  const filter = useArena((s) => s.filter);
  const designer = useArena((s) => s.designer);
  const candidates = useArena((s) => s.candidates);
  const verdicts = useArena((s) => s.verdicts);
  const libCount = useArena((s) => s.library.length);

  const visible = useMemo(
    () => computeVisible(candidates, verdicts, filter, designer),
    [candidates, verdicts, filter, designer],
  );

  // the designer dropdown is built from what is actually on the wall, with counts
  const designers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of candidates) counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
    return [...counts.entries()]
      .map(([model, n]) => ({ model, n, label: designerLabel(model) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [candidates]);

  const [meter, setMeter] = useState<Meter>({ spentUsd: 0, capUsd: 0, calls: 0, stopped: false });
  const [tuner, setTuner] = useState<Candidate | null>(null);
  const [gen, setGen] = useState(false);
  const [lbIndex, setLbIndex] = useState<number | null>(null);
  const [density, setDensity] = useState<keyof typeof DENSITY>("M");
  const [playing, setPlaying] = useState(transport.get().playing);
  const [toast, setToast] = useState<string | null>(null);
  const toastT = useRef<number>();

  const refreshMeter = useCallback(() => void getMeter().then(setMeter), []);
  useEffect(() => {
    refreshMeter();
    return transport.subscribe((s) => setPlaying(s.playing));
  }, [refreshMeter]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(null), 1500);
  }, []);

  const openLightbox = useCallback(
    (id: string) => {
      const i = visible.findIndex((c) => c.id === id);
      if (i >= 0) setLbIndex(i);
    },
    [visible],
  );

  const pct = meter.capUsd > 0 ? Math.min(1, meter.spentUsd / meter.capUsd) : 0;
  const meterClass = pct >= 1 ? "meter stop" : pct >= 0.8 ? "meter warn" : "meter";

  return (
    <div className="arena" style={{ ["--tile-min" as string]: DENSITY[density] }}>
      <header className="arena-top">
        <div className="arena-brand">
          <span className="mark">MOSH<em>·</em>ARENA</span>
          <span className="sub">taste bench</span>
        </div>

        <div className="seg" role="tablist" aria-label="filter target">
          <button className={filter === "all" ? "on" : ""} onClick={() => arena.setFilter("all")}>ALL</button>
          {TARGETS.filter((t) => ["shell", "moshi", "stage", "waveform", "companion"].includes(t.id)).map((t) => (
            <button key={t.id} className={filter === t.id ? "on" : ""} onClick={() => arena.setFilter(t.id as Target)}>
              {t.label.split(" ")[0]}
            </button>
          ))}
        </div>

        <select
          className="designer-sel"
          aria-label="filter designer"
          title="filter by designer"
          value={designer}
          onChange={(e) => arena.setDesigner(e.target.value)}
        >
          <option value="all">ALL DESIGNERS</option>
          {designers.map((d) => (
            <option key={d.model} value={d.model}>{d.label} · {d.n}</option>
          ))}
        </select>

        <div className="seg" aria-label="clip material fixture" title="clip material: audio / midi / drums">
          {MODE_NAMES.map((m, i) => (
            <button key={m} className={mode === i ? "on" : ""} onClick={() => arena.setMode(i as 0 | 1 | 2)}>{m}</button>
          ))}
        </div>

        <div className="arena-spacer" />

        <button className="tbtn" onClick={() => transport.toggle()} title="play/pause (space)" aria-pressed={playing}>
          {playing ? "❚❚" : "▶"}
        </button>

        <div className="seg" role="tablist" aria-label="judging mode">
          <button className={view === "grid" ? "on" : ""} onClick={() => arena.setView("grid")}>GRID</button>
          <button className={view === "avb" ? "on" : ""} onClick={() => arena.setView("avb")}>A · B</button>
        </div>

        {view === "grid" && (
          <div className="seg" aria-label="tile size">
            {(["S", "M", "L"] as const).map((d) => (
              <button key={d} className={density === d ? "on" : ""} onClick={() => setDensity(d)}>{d}</button>
            ))}
          </div>
        )}

        {meter.capUsd > 0 && (
          <div className={meterClass} title={`${meter.calls} calls`}>
            <div className="bar"><div className="fill" style={{ width: `${pct * 100}%` }} /></div>
            <span className="val"><b>${meter.spentUsd.toFixed(2)}</b> / ${meter.capUsd.toFixed(2)}</span>
          </div>
        )}

        <button className="btn ghost" title="saved winners">★ {libCount}</button>
        <button className="btn primary" onClick={() => setGen(true)}>✦ Summon</button>
      </header>

      <div className="arena-body">
        {view === "grid" ? (
          <Grid list={visible} mode={mode} onOpen={openLightbox} onTune={setTuner} onToast={showToast} />
        ) : (
          <AvsB onOpen={openLightbox} onToast={showToast} />
        )}
      </div>

      {lbIndex !== null && visible.length > 0 && (
        <Lightbox
          list={visible}
          index={Math.min(lbIndex, visible.length - 1)}
          setIndex={setLbIndex}
          onClose={() => setLbIndex(null)}
          onTune={(c) => { setLbIndex(null); setTuner(c); }}
          onToast={showToast}
          initialMode={mode}
        />
      )}
      {tuner && <Tuner cand={tuner} onClose={() => setTuner(null)} onToast={showToast} />}
      {gen && <GeneratePanel onClose={() => setGen(false)} onToast={showToast} onMeter={refreshMeter} />}

      <div className={`toast${toast ? " show" : ""}`} aria-live="polite">{toast ?? ""}</div>

      <span style={{ position: "fixed", bottom: 6, left: 10, fontSize: 9, color: "var(--a-faint)", fontFamily: "var(--font-mono)" }}>
        {candidates.length} candidates
      </span>
    </div>
  );
}
