/**
 * Timeline — Ruler + one Lane per track + ClipViews + Playhead.
 *
 * Geometry comes from UI-local view state: pixels-per-second (zoom) and a
 * scroll offset in seconds. Clip positions come from the snapshot (clip.range,
 * in seconds). Drag/trim/split each emit a command and let the resulting event
 * update the mirror — the UI does not optimistically rewrite the snapshot.
 *
 * The playhead is driven purely by transport.position (fed by decimated
 * transport_position events). Render-layer badges read live status from the
 * snapshot plus a small local progress map kept from layer_render_progress.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  executeCommand,
  subscribe,
  type ClipState,
  type ColorDescriptor,
  type RenderLayerState,
  type TrackState,
} from "../bridge";
import { useStore } from "../store";
import { beatsPerBar, secPerBar, secPerBeat } from "../timeutil";

const LANE_HEIGHT = 92; // must match .lane height in CSS
const RULER_HEIGHT = 28;

// --- Color Rack descriptor (05 §6) ------------------------------------------
// Fetched ONCE through the seam (the `get_colors` command → service `/colors`),
// shared by every clip's rack. The SA3 service warms up for a few seconds at launch,
// so retry until the descriptor is non-empty. (A non-SA3 backend returns [] and the
// rack simply shows no colors.) The UI never talks to the service directly.
let _colorCache: ColorDescriptor[] | null = null;
let _colorFetching = false;
const _colorSubs = new Set<() => void>();

function fetchColorsOnce() {
  if (_colorFetching || _colorCache) return;
  _colorFetching = true;
  const attempt = async (n: number) => {
    try {
      const res = await executeCommand("get_colors", {});
      const cols = (res.data?.colors as ColorDescriptor[] | undefined) ?? [];
      if (cols.length > 0) {
        _colorCache = cols;
        _colorSubs.forEach((f) => f());
        return;
      }
    } catch {
      /* service not up yet — retry below */
    }
    if (n < 30) window.setTimeout(() => void attempt(n + 1), 1500);
    else _colorFetching = false;
  };
  void attempt(0);
}

function useColorRack(): ColorDescriptor[] {
  const [, force] = useState(0);
  useEffect(() => {
    if (_colorCache) return;
    fetchColorsOnce();
    const sub = () => force((x) => x + 1);
    _colorSubs.add(sub);
    return () => {
      _colorSubs.delete(sub);
    };
  }, []);
  return _colorCache ?? [];
}

// --- Ruler ------------------------------------------------------------------

function Ruler({
  pxPerSec,
  scrollSec,
  widthSec,
  bpm,
  sig,
  onScrub,
}: {
  pxPerSec: number;
  scrollSec: number;
  widthSec: number;
  bpm: number;
  sig: string;
  onScrub: (sec: number) => void;
}) {
  const sBar = secPerBar(bpm, sig);
  const bars: { sec: number; label: number }[] = [];
  const firstBar = Math.floor(scrollSec / sBar);
  const lastBar = Math.ceil((scrollSec + widthSec) / sBar);
  for (let b = Math.max(0, firstBar); b <= lastBar; b++) {
    bars.push({ sec: b * sBar, label: b + 1 });
  }

  // Beat sub-ticks only when zoomed in enough to be useful.
  const showBeats = pxPerSec * secPerBeat(bpm) > 14;
  const beatsBar = beatsPerBar(sig);

  return (
    <div
      className="ruler"
      style={{ height: RULER_HEIGHT }}
      onMouseDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const sec = scrollSec + (e.clientX - rect.left) / pxPerSec;
        onScrub(Math.max(0, sec));
      }}
    >
      {bars.map((bar) => {
        const x = (bar.sec - scrollSec) * pxPerSec;
        return (
          <div key={`bar-${bar.label}`}>
            <div className="ruler-bar" style={{ left: x }}>
              <span className="ruler-label">{bar.label}</span>
            </div>
            {showBeats &&
              Array.from({ length: beatsBar - 1 }, (_, i) => {
                const bx = x + (i + 1) * secPerBeat(bpm) * pxPerSec;
                return (
                  <div key={`beat-${bar.label}-${i}`} className="ruler-beat" style={{ left: bx }} />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

// --- ClipView ---------------------------------------------------------------

type DragMode = "move" | "trim-l" | "trim-r" | null;

function ClipView({
  clip,
  pxPerSec,
  scrollSec,
}: {
  clip: ClipState;
  pxPerSec: number;
  scrollSec: number;
}) {
  const selected = useStore((s) => s.selectedClip === clip.id);
  const selectClip = useStore((s) => s.selectClip);

  // Local drag state, applied as a single command on mouse-up so we don't spam
  // the backend. While dragging we render a preview offset; the authoritative
  // position arrives via the clip_moved event after the command resolves.
  const [drag, setDrag] = useState<{
    mode: DragMode;
    startX: number;
    origRange: [number, number];
  } | null>(null);
  const [preview, setPreview] = useState<[number, number] | null>(null);

  const range = preview ?? clip.range;
  const left = (range[0] - scrollSec) * pxPerSec;
  const width = Math.max(2, (range[1] - range[0]) * pxPerSec);

  const beginDrag = (mode: DragMode, e: React.MouseEvent) => {
    e.stopPropagation();
    selectClip(clip.id);
    setDrag({ mode, startX: e.clientX, origRange: clip.range });
    setPreview(clip.range);
  };

  useEffect(() => {
    if (!drag) return;
    // Compute the target range for a pointer x, given this drag's mode/origin.
    // Derived purely from the event — never from React state — so a fast
    // mousemove→mouseup in the same tick still commits the correct range.
    const computeRange = (clientX: number): [number, number] => {
      const dSec = (clientX - drag.startX) / pxPerSec;
      const [s0, e0] = drag.origRange;
      if (drag.mode === "trim-l") {
        const ns = Math.max(0, Math.min(e0 - 0.05, s0 + dSec));
        return [ns, e0];
      }
      if (drag.mode === "trim-r") {
        const ne = Math.max(s0 + 0.05, e0 + dSec);
        return [s0, ne];
      }
      const ns = Math.max(0, s0 + dSec); // move
      return [ns, ns + (e0 - s0)];
    };

    const onMove = (e: MouseEvent) => {
      setPreview(computeRange(e.clientX)); // render-only preview
    };
    const onUp = (e: MouseEvent) => {
      const r = computeRange(e.clientX);
      if (drag.mode === "move") {
        void executeCommand("move_clip", { clip: clip.id, start: r[0] });
      } else if (drag.mode === "trim-l") {
        void executeCommand("trim_clip", { clip: clip.id, start: r[0] });
      } else if (drag.mode === "trim-r") {
        void executeCommand("trim_clip", { clip: clip.id, end: r[1] });
      }
      setDrag(null);
      setPreview(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, pxPerSec, clip.id]);

  const splitHere = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Split at the double-click x position.
    const rect = (e.currentTarget as HTMLElement)
      .closest(".clip")!
      .getBoundingClientRect();
    const at = clip.range[0] + (e.clientX - rect.left) / pxPerSec;
    void executeCommand("split_clip", { clip: clip.id, at });
  };

  // Tier-B generate via the COLOR RACK (05 §6): pick a prompt + ASTD-clamped colors
  // (+ Lab) on this clip, then create a RenderLayer and render it through the out-of-
  // process job service (TIER WALL). Colors map to real SA3 activation steering in the
  // adapter. The result lands non-destructively via accept (badge buttons).
  const colorDescriptors = useColorRack();
  const [rackOpen, setRackOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [mode, setMode] = useState<"reimagine" | "generate">("reimagine");
  const [prompt, setPrompt] = useState("");
  const [lab, setLab] = useState(false);
  const [vals, setVals] = useState<Record<string, number>>({}); // name → 0..100 (50 = neutral)

  const valFor = (n: string) => vals[n] ?? 50;
  const activeColors = colorDescriptors
    .map((c) => ({ name: c.name, value: valFor(c.name) }))
    .filter((c) => c.value !== 50)
    .slice(0, 3); // composition cap (05 §6)

  const render = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await executeCommand("create_render_layer", {
        clip: clip.id,
        mode,
        prompt: prompt || mode,
        colors: activeColors,
        lab,
      });
      const layerId = res.data?.id as string | undefined;
      if (layerId) await executeCommand("render_layer", { layer: layerId });
      setRackOpen(false);
    } finally {
      setGenerating(false);
    }
  };

  // Simple deterministic fake waveform bars (no audio on the web thread; real
  // build supplies peaks/thumbnail via the backend — see 03 §5).
  const bars = makeFakeWave(clip.id, Math.max(4, Math.floor(width / 4)));

  return (
    <div
      className={`clip ${selected ? "selected" : ""}`}
      style={{ left, width }}
      onMouseDown={(e) => beginDrag("move", e)}
      onDoubleClick={splitHere}
      title={`${clip.id} · ${range[0].toFixed(2)}–${range[1].toFixed(2)}s · double-click to split`}
    >
      <div className="clip-trim left" onMouseDown={(e) => beginDrag("trim-l", e)} />
      <div className="clip-wave">
        {bars.map((h, i) => (
          <span key={i} className="wave-bar" style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="clip-label">{clip.id.replace(/^clip:/, "")}</div>
      <button
        className={`clip-gen ${rackOpen ? "open" : ""}`}
        title="Color Rack (Tier-B generate / reimagine with steering)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setRackOpen((o) => !o);
        }}
      >
        {generating ? "…" : "✦"}
      </button>
      {rackOpen && (
        <ColorRack
          descriptors={colorDescriptors}
          mode={mode}
          setMode={setMode}
          prompt={prompt}
          setPrompt={setPrompt}
          lab={lab}
          setLab={setLab}
          valFor={valFor}
          setVals={setVals}
          activeCount={activeColors.length}
          generating={generating}
          onRender={render}
          onClose={() => setRackOpen(false)}
        />
      )}
      <div className="clip-trim right" onMouseDown={(e) => beginDrag("trim-r", e)} />
    </div>
  );
}

// --- Color Rack popover -----------------------------------------------------

function ColorRack({
  descriptors,
  mode,
  setMode,
  prompt,
  setPrompt,
  lab,
  setLab,
  valFor,
  setVals,
  activeCount,
  generating,
  onRender,
  onClose,
}: {
  descriptors: ColorDescriptor[];
  mode: "reimagine" | "generate";
  setMode: (m: "reimagine" | "generate") => void;
  prompt: string;
  setPrompt: (p: string) => void;
  lab: boolean;
  setLab: (b: boolean) => void;
  valFor: (n: string) => number;
  setVals: (f: (s: Record<string, number>) => Record<string, number>) => void;
  activeCount: number;
  generating: boolean;
  onRender: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="color-rack"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="cr-head">
        <div className="cr-modes">
          {(["reimagine", "generate"] as const).map((m) => (
            <button
              key={m}
              className={`cr-mode ${mode === m ? "on" : ""}`}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <button className="cr-close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <input
        className="cr-prompt"
        placeholder="prompt…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="cr-colors">
        {descriptors.length === 0 && (
          <div className="cr-empty">colors loading… (model service warming up)</div>
        )}
        {descriptors.map((c) => {
          const v = valFor(c.name);
          const active = v !== 50;
          const atCap = !active && activeCount >= 3;
          return (
            <div key={c.name} className={`cr-color ${active ? "on" : ""}`}>
              <span className="cr-name" title={`${c.verdict} · peak L${c.peak_layer} · ASTD≤${c.astd_max}`}>
                {c.name}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={v}
                disabled={atCap}
                onChange={(e) =>
                  setVals((s) => ({ ...s, [c.name]: Number(e.target.value) }))
                }
              />
              <span className="cr-val">{active ? v : "·"}</span>
            </div>
          );
        })}
      </div>
      <div className="cr-foot">
        <label className="cr-lab" title="Unlock color strength past the quality-safe clamp">
          <input type="checkbox" checked={lab} onChange={(e) => setLab(e.target.checked)} />
          Lab
        </label>
        <button className="cr-render" onClick={onRender} disabled={generating}>
          {generating
            ? "rendering…"
            : `render${activeCount ? ` · ${activeCount} color${activeCount > 1 ? "s" : ""}` : ""}`}
        </button>
      </div>
    </div>
  );
}

function makeFakeWave(seed: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const v = (Math.abs(h) % 1000) / 1000;
    out.push(20 + v * 70);
  }
  return out;
}

// --- Render-layer badge -----------------------------------------------------

function LayerBadges({
  layers,
  progress,
}: {
  layers: RenderLayerState[];
  progress: Record<string, { pct: number; etaSec: number }>;
}) {
  if (layers.length === 0) return null;
  return (
    <div className="layer-badges">
      {layers.map((l) => {
        const p = progress[l.id];
        const q = l.quality;
        return (
          <span key={l.id} className={`layer-badge ${l.status}`}>
            {l.mode ?? "layer"}
            {l.status === "rendering" && p
              ? ` ${Math.round(p.pct)}% · ${p.etaSec.toFixed(1)}s`
              : ` · ${l.status}`}
            {l.colors && l.colors.length > 0 && (
              <span className="layer-colors">
                {l.colors.map((c) => `${c.name} ${c.value}`).join(" · ")}
                {l.lab ? " · lab" : ""}
              </span>
            )}
            {l.status === "ready" && q && (
              <span
                className="layer-quality"
                title={
                  (q.flags && q.flags.length ? q.flags : ["no flags"]).join("\n") +
                  (q.judge === "audiobox"
                    ? "\n(Audiobox-Aesthetics — learned PQ)"
                    : "\n(DSP heuristic readout)")
                }
              >
                {typeof q.pq === "number" && (
                  <span className={`pq ${q.judge === "audiobox" ? "learned" : ""}`}>
                    pq {q.pq.toFixed(1)}
                    {q.judge === "audiobox" ? "★" : ""}
                  </span>
                )}
                {typeof q.pqDelta === "number" && (
                  <span className={`pqd ${q.pqDelta >= 0 ? "up" : "down"}`}>
                    {q.pqDelta >= 0 ? "▲" : "▼"}
                    {Math.abs(q.pqDelta).toFixed(1)}
                  </span>
                )}
                {q.initLatentCache === "hit" && <span className="cache" title="init-latent cache hit">⚡</span>}
                {q.flags && q.flags.length > 0 && <span className="flags">⚠{q.flags.length}</span>}
              </span>
            )}
            {l.status === "ready" && (
              <span className="layer-actions">
                <button
                  className="layer-accept"
                  title="Accept (land on Neural lane, source untouched)"
                  onClick={(e) => {
                    e.stopPropagation();
                    void executeCommand("accept_render", { layer: l.id });
                  }}
                >
                  ✓
                </button>
                <button
                  className="layer-reject"
                  title="Reject"
                  onClick={(e) => {
                    e.stopPropagation();
                    void executeCommand("reject_render", { layer: l.id });
                  }}
                >
                  ✕
                </button>
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// --- Lane -------------------------------------------------------------------

function Lane({
  track,
  pxPerSec,
  scrollSec,
  layerProgress,
}: {
  track: TrackState;
  pxPerSec: number;
  scrollSec: number;
  layerProgress: Record<string, { pct: number; etaSec: number }>;
}) {
  const selectTrack = useStore((s) => s.selectTrack);
  const selectClip = useStore((s) => s.selectClip);

  const addClipHere = (e: React.MouseEvent) => {
    // Click on empty lane area drops a clip there (import_clip with a fake clip).
    if ((e.target as HTMLElement).closest(".clip")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const start = Math.max(0, scrollSec + (e.clientX - rect.left) / pxPerSec);
    selectTrack(track.id);
    selectClip(null);
    void executeCommand("import_clip", { track: track.id, start, length: 4 });
  };

  return (
    <div
      className="lane"
      style={{ height: LANE_HEIGHT }}
      onMouseDown={addClipHere}
    >
      <LayerBadges layers={track.renderLayers} progress={layerProgress} />
      {track.clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          pxPerSec={pxPerSec}
          scrollSec={scrollSec}
        />
      ))}
    </div>
  );
}

// --- Timeline (composite) ---------------------------------------------------

export default function Timeline() {
  const snapshot = useStore((s) => s.snapshot);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const scrollSec = useStore((s) => s.scrollSec);
  const setZoom = useStore((s) => s.setZoom);
  const setScroll = useStore((s) => s.setScroll);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(800);

  // Local map of render-layer progress (pct/eta) — not in the snapshot schema.
  const [layerProgress, setLayerProgress] = useState<
    Record<string, { pct: number; etaSec: number }>
  >({});

  useEffect(() => {
    return subscribe((ev) => {
      if (ev.type === "layer_render_progress") {
        setLayerProgress((m) => ({
          ...m,
          [ev.id]: { pct: ev.pct, etaSec: ev.etaSec },
        }));
      } else if (ev.type === "layer_status" && ev.status !== "rendering") {
        setLayerProgress((m) => {
          const next = { ...m };
          delete next[ev.id];
          return next;
        });
      }
    });
  }, []);

  // Track the visible width so the ruler knows how many bars to draw.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setWidthPx(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // zoom around the cursor
        const rect = e.currentTarget.getBoundingClientRect();
        const cursorSec = scrollSec + (e.clientX - rect.left) / pxPerSec;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = pxPerSec * factor;
        setZoom(next);
        // keep cursorSec under the cursor after zoom
        const clamped = Math.max(16, Math.min(400, next));
        setScroll(cursorSec - (e.clientX - rect.left) / clamped);
      } else {
        setScroll(scrollSec + e.deltaX / pxPerSec + (e.deltaY / pxPerSec) * 0.5);
      }
    },
    [pxPerSec, scrollSec, setZoom, setScroll]
  );

  if (!snapshot) return <div className="timeline" />;

  const widthSec = widthPx / pxPerSec;
  const { bpm, sig } = snapshot.tempo;
  const playheadX = (snapshot.transport.position - scrollSec) * pxPerSec;
  const loop = snapshot.transport.loop;

  return (
    <div className="timeline">
      <div className="timeline-tools">
        <button className="zoom-btn" onClick={() => setZoom(pxPerSec / 1.3)} title="Zoom out">
          −
        </button>
        <span className="zoom-readout">{Math.round(pxPerSec)} px/s</span>
        <button className="zoom-btn" onClick={() => setZoom(pxPerSec * 1.3)} title="Zoom in">
          +
        </button>
        <span className="tl-hint">
          click lane = add clip · drag = move · edges = trim · dbl-click = split ·
          ctrl+wheel = zoom
        </span>
      </div>

      <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
        <Ruler
          pxPerSec={pxPerSec}
          scrollSec={scrollSec}
          widthSec={widthSec}
          bpm={bpm}
          sig={sig}
          onScrub={(sec) => void executeCommand("set_transport", { position: sec })}
        />

        <div className="lanes">
          {snapshot.tracks.map((t) => (
            <Lane
              key={t.id}
              track={t}
              pxPerSec={pxPerSec}
              scrollSec={scrollSec}
              layerProgress={layerProgress}
            />
          ))}
          {snapshot.tracks.length === 0 && (
            <div className="lanes-empty">Add a track to start arranging.</div>
          )}
        </div>

        {/* loop region overlay */}
        {loop && (
          <div
            className="loop-region"
            style={{
              left: (loop[0] - scrollSec) * pxPerSec,
              width: (loop[1] - loop[0]) * pxPerSec,
            }}
          />
        )}

        {/* playhead spans the ruler + lanes */}
        <div className="playhead" style={{ left: playheadX }} />
      </div>
    </div>
  );
}
