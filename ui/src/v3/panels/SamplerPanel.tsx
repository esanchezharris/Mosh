// The Sampler panel (instrument-panels contract §3b, wire §1e/§1f). Three views of the same
// sampler, chosen by what it holds (sampler.ts viewOf):
//   drum     the loaded sounds as a compact grid sorted by note; a tap plays one, a drop on a
//            cell replaces it (asked first when something is replaced), selecting one opens a
//            single row: Level, Pan, Choke, Clear.
//   melodic  one sound played across the keys: its waveform (real peaks, or none), a key strip
//            with its range, root and the keys held right now, and the same row.
//   empty    "Drop a sample or load a kit".
// Every pad write (set_drum_pad) rebuilds the sampler in the engine and cuts the sounds that
// are ringing, so a control previews while it moves and sends ONE command on release (keys
// and the wheel: once they go quiet). Live data is only the plugin_meters rail: hits flash a
// cell once per frame, held keys light the strip, the output bar is what the sampler adds.
// Choke is never claimed live: the engine applies it only when Apply choke bakes a clip.
// What is quiet is the engine's own `silenced` flag; a solo left on a note no sound is
// rooted on (which silences everything) is named in the top row with a one-click Unsolo.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { pickFiles } from "../../bridge";
import { noteName } from "../../musicalKey";
import type { SamplerMeter, SamplerSound } from "../../types";
import { addRecentSample, importedFilePath } from "../../ui/sampleBrowserUtil";
import { Dial } from "./Dial";
import { MeterBar, useMeterEvents, usePluginMeter, type MeterFlash } from "./meters";
import {
  CHOKE_MAX, DEFAULT_ROOT, FIRST_PAD_NOTE, GAIN_STEP_DB, NO_LANE, dragCarriesSample, levelKeyStep, panKeyStep, droppedSample, emptyCellCount, fileName,
  fmtLevel, fmtPan, fmtSeconds, freeSlotNotes, gainFromNorm, gainNorm, gridEdge, keyCentre, laneOf, laneWords,
  limitsOf, miniDots, notesText, orphanLanes, panFromNorm, panNorm, peaksArea, pianoKeys, rangeText, replaceText, replacedBy, samplerSummary,
  scrollToShow, sortSounds, soundFlash, soundKey, soundsOf, viewOf, type GridEdge, type LaneState,
} from "./sampler";
import { clamp } from "./params";
import type { PanelDef, PanelProps, RunCommand } from "./types";

/** A key or wheel burst is sent once it has been quiet this long. */
const KEY_COMMIT_MS = 400;
/** How long a sent value stays on screen at most while the engine's snapshot arrives. */
const PENDING_MS = 1500;
/** A tap's own feedback (the rail's hit flash follows it). */
const PRESS_MS = 120;
/** A notice in the top row (a refused drop, a silent audition) stays this long. */
const NOTICE_MS = 4000;
/** Waveform resolution: about one bucket per 2 px of the strip. */
const PEAK_BUCKETS = 136;
const WAVE_W = 273, WAVE_H = 24, KEYS_H = 12;
const AUDITION_VELOCITY = 100;

type Limits = ReturnType<typeof limitsOf>;
type Mode = "drum" | "melodic";
/** What the row under the grid shows besides the selected sound's controls. */
type Slot =
  | { kind: "confirm"; note: number; path: string; mode: Mode; replaced: SamplerSound[]; onto?: SamplerSound }
  | { kind: "choose"; path: string }
  | { kind: "kits" };

// ── commit on release ──────────────────────────────────────────────────────────────────

/** A value that previews while a control moves and is sent ONCE: on pointer release, or
 *  when a burst of keys / wheel notches has been quiet KEY_COMMIT_MS, or on blur / unmount.
 *  The sent value stays on screen until the snapshot shows it (or PENDING_MS, or a refusal).
 *  `handlers` go on an element wrapping the control (pointer down is read in the capture
 *  phase: the Dial stops its own pointerdown from bubbling). Only a press on the dial itself
 *  holds the commit (it takes pointer capture); a press on its caption or read-out does not,
 *  and any release anywhere ends the hold, so keys and the wheel are never held back. */
function useReleaseCommit(snap: number, commit: (v: number) => Promise<boolean>, same: (a: number, b: number) => boolean) {
  const [preview, setPreview] = useState<number | null>(null);
  const st = useRef<{
    pending: number | null; down: boolean; sent: number | null; off?: () => void;
    timer?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout>;
  }>({ pending: null, down: false, sent: null });
  const latest = useRef({ snap, commit, same });
  latest.current = { snap, commit, same };
  // The value on screen, readable by the next key before React re-renders.
  const shown = useRef(snap);
  shown.current = preview ?? snap;
  const flush = useCallback(() => {
    const s = st.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    const v = s.pending;
    s.pending = null;
    if (v === null) return;
    // Nothing to send when the engine already has it (what was sent last, else the snapshot).
    if (latest.current.same(v, s.sent ?? latest.current.snap)) { if (s.sent === null) setPreview(null); return; }
    s.sent = v;
    if (s.settle) clearTimeout(s.settle);
    s.settle = setTimeout(() => { s.settle = undefined; s.sent = null; setPreview(null); }, PENDING_MS);
    const drop = () => { if (s.sent === v) { s.sent = null; setPreview(null); } };
    void latest.current.commit(v).then((ok) => { if (!ok) drop(); }, drop);
  }, []);
  const change = useCallback((v: number) => {
    const s = st.current;
    s.pending = v;
    shown.current = v;
    setPreview(v);
    if (s.down) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(flush, KEY_COMMIT_MS);
  }, [flush]);
  // The snapshot caught up with what was sent: show the snapshot again.
  useEffect(() => {
    const s = st.current;
    if (s.sent !== null && s.pending === null && !s.down && same(snap, s.sent)) {
      s.sent = null;
      if (s.settle) { clearTimeout(s.settle); s.settle = undefined; }
      setPreview(null);
    }
  }, [snap, same]);
  const release = useCallback(() => {
    const s = st.current;
    s.off?.();
    s.off = undefined;
    if (!s.down) return;
    s.down = false;
    flush();
  }, [flush]);
  // Unmounted mid-burst (another sound selected, the panel minimized): still send it.
  useEffect(() => () => {
    st.current.off?.();
    st.current.down = false;
    flush();
    if (st.current.settle) clearTimeout(st.current.settle);
  }, [flush]);
  const handlers = {
    onPointerDownCapture: (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (!target?.closest?.('svg[role="slider"]')) return;
      const s = st.current;
      s.down = true;
      if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
      // The release normally comes back through the dial (it holds the pointer); a window
      // listener (bubble phase: after the dial's own last value) is the backstop.
      if (!s.off) {
        const end = () => release();
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
        s.off = () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
      }
    },
    onPointerUp: release, onPointerCancel: release, onLostPointerCapture: release,
    // Focus leaving the control ends any hold (a drag is over by then) and sends what waits.
    onBlur: () => { st.current.off?.(); st.current.off = undefined; st.current.down = false; flush(); },
  };
  return { preview, change, handlers, shown: () => shown.current };
}

const sameDb = (a: number, b: number) => Math.abs(a - b) < 0.05;
const samePan = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** run() resolves to "did the engine accept it". */
async function accepted(p: Promise<{ ok: boolean }> | undefined): Promise<boolean> {
  try { return !!(await p)?.ok; } catch { return false; }
}

// ── file peaks, cached by path ─────────────────────────────────────────────────────────

type PeaksEntry = "loading" | "none" | [number, number][];
const peaksCache = new Map<string, PeaksEntry>();
const peaksListeners = new Set<() => void>();

/** The waveform of an absolute file (file_peaks), fetched once per path and kept. Null while
 *  loading or when there is none to show: never made-up peaks. */
function usePeaks(path: string | null, run: RunCommand | undefined): [number, number][] | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    peaksListeners.add(bump);
    return () => { peaksListeners.delete(bump); };
  }, []);
  useEffect(() => {
    const r = runRef.current;
    if (!path || !r || peaksCache.has(path)) return;
    peaksCache.set(path, "loading");
    const done = (v: PeaksEntry) => { peaksCache.set(path, v); peaksListeners.forEach((f) => f()); };
    r("file_peaks", { path, buckets: PEAK_BUCKETS }).then(
      (res) => done(res.ok && Array.isArray(res.data?.peaks) && res.data!.peaks.length > 0 ? res.data!.peaks : "none"),
      () => done("none"));
  }, [path]);
  const v = path ? peaksCache.get(path) : undefined;
  return Array.isArray(v) ? v : null;
}

// ── the selected sound's row ───────────────────────────────────────────────────────────

/** Level, Pan, Choke (one-shot pads only), Mute (melodic view), Clear, and what the sound is.
 *  Keyed by the sound, so its pending values belong to it. */
function SoundRow({ s, lane, limits, run, readOnly, showMute, onPreviewGain, onCleared }: {
  s: SamplerSound; lane: LaneState; limits: Limits; run?: RunCommand; readOnly: boolean; showMute: boolean;
  onPreviewGain: (db: number | null) => void; onCleared: () => void;
}) {
  const note = s.addressNote;
  const editable = !readOnly && !!run && note !== undefined;
  const set = (args: { gainDb?: number; pan?: number; chokeGroup?: number }) =>
    note === undefined || !run ? Promise.resolve(false) : accepted(run("set_drum_pad", { note, ...args }));
  const lvl = useReleaseCommit(s.userGainDb, (db) => set({ gainDb: db }), sameDb);
  const pan = useReleaseCommit(s.pan, (p) => set({ pan: p }), samePan);
  const [choke, setChoke] = useState<number | null>(null);
  const snapChoke = s.chokeGroup ?? 0;
  useEffect(() => { setChoke(null); }, [snapChoke]);
  useEffect(() => {
    if (choke === null) return;
    const t = setTimeout(() => setChoke(null), PENDING_MS);
    return () => clearTimeout(t);
  }, [choke]);
  const gain = lvl.preview ?? s.userGainDb;
  const panV = pan.preview ?? s.pan;
  // Keys and the wheel step whole dB / percent from the value shown (the dial's own fine
  // steps would round back onto the same half-decibel); Home/End stay the dial's ends.
  const stepLevel = (d: number) => {
    const next = clamp(Math.round((lvl.shown() + d) / GAIN_STEP_DB) * GAIN_STEP_DB, limits.minGainDb, limits.maxGainDb);
    if (next !== lvl.shown()) lvl.change(next);
  };
  const stepPan = (d: number) => {
    const next = clamp(Math.round((pan.shown() + d) * 100) / 100, -1, 1);
    if (next !== pan.shown()) pan.change(Object.is(next, -0) ? 0 : next);
  };
  const keyed = (step: (key: string, shift: boolean) => number | null, apply: (d: number) => void) => (e: KeyboardEvent) => {
    if (!editable) return;
    const d = step(e.key, e.shiftKey);
    if (d === null) return;
    e.preventDefault();
    e.stopPropagation();
    apply(d);
  };
  useEffect(() => { onPreviewGain(lvl.preview); }, [lvl.preview, onPreviewGain]);
  useEffect(() => () => onPreviewGain(null), [onPreviewGain]);

  const why = readOnly ? "Read-only: pad edits go to the first sampler on this track"
    : note === undefined ? "Not reachable: a narrower sound covers every note it plays" : undefined;
  const status = s.missing ? "file missing" : laneWords(s, lane);
  // The root of a sound played across the keys is marked on its key strip (melodic view) or
  // its cell (grid); a partial range names it here.
  const sub = s.mode === "range" ? `${rangeText(s)} · root ${noteName(s.pitch)}` : rangeText(s);
  const dur = fmtSeconds(s.durationSec);
  return (
    <div className="pp-sampler-row" data-testid="pp-sampler-row" data-sound={soundKey(s)}>
      <div className="pp-sampler-info" title={s.path || s.file || s.name}>
        <span className="nm">{s.name}</span>
        <span className="sub">{sub}{dur ? ` · ${dur}` : ""}</span>
        <span className={`st${s.missing ? " warn" : ""}`} data-testid="pp-sampler-status">{status}</span>
      </div>
      <div className="pp-sampler-ctl" {...lvl.handlers} onKeyDownCapture={keyed(levelKeyStep, stepLevel)}>
        <Dial label="Level" testId="pp-sampler-level" size={26} disabled={!editable} title={why}
          onWheelNotches={(n, shift) => stepLevel(n * (levelKeyStep("ArrowUp", shift) ?? 1))}
          norm={gainNorm(gain, limits)} origin={gainNorm(0, limits)} defaultNorm={gainNorm(0, limits)}
          quantize={(n) => gainNorm(gainFromNorm(n, limits), limits)}
          display={fmtLevel(gain)} valueText={`${fmtLevel(gain)}${s.silenced ? " (parked while silent)" : ""}`}
          onChange={(n) => lvl.change(gainFromNorm(n, limits))} />
      </div>
      <div className="pp-sampler-ctl" {...pan.handlers} onKeyDownCapture={keyed(panKeyStep, stepPan)}>
        <Dial label="Pan" testId="pp-sampler-pan" size={26} bipolar disabled={!editable} title={why}
          onWheelNotches={(n, shift) => stepPan(n * (panKeyStep("ArrowUp", shift) ?? 0.05))}
          norm={panNorm(panV)} defaultNorm={0.5} quantize={(n) => panNorm(panFromNorm(n))}
          display={fmtPan(panV)} valueText={panV === 0 ? "centre" : fmtPan(panV)}
          onChange={(n) => pan.change(panFromNorm(n))} />
      </div>
      {s.mode === "drum" ? (
        <label className="pp-sampler-choke" title={"Choke group. Pads in one group cut each other off only where Apply choke bakes it "
          + "into a clip, not while playing live. A pad in a group stops at the end of its note."}>
          <select data-testid="pp-sampler-choke" value={choke ?? snapChoke} disabled={!editable}
            aria-label={`Choke group for ${s.name}`}
            onChange={(e) => {
              const g = Number(e.target.value);
              setChoke(g);
              void set({ chokeGroup: g }).then((ok) => { if (!ok) setChoke(null); });
            }}>
            <option value={0}>none</option>
            {Array.from({ length: CHOKE_MAX }, (_, i) => i + 1).map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <span className="nm">Choke</span>
        </label>
      ) : showMute ? (
        <div className="pp-sampler-choke">
          <button type="button" className="pp-btn" data-testid="pp-sampler-mute" aria-pressed={lane.muted} disabled={readOnly || !run}
            title={`Mute ${s.name} (its root note's lane)`}
            onClick={() => { if (run) void run("set_drum_lane", { note: s.pitch, mute: !lane.muted }); }}>M</button>
          <span className="nm">Mute</span>
        </div>
      ) : <span />}
      <button type="button" className="pp-btn pp-sampler-clear" data-testid="pp-sampler-clear" disabled={!editable}
        title={why ?? `Remove ${s.name} from the sampler`}
        onClick={() => {
          if (note === undefined || !run) return;
          void accepted(run("clear_drum_pad", { note })).then((ok) => { if (ok) onCleared(); });
        }}>Clear</button>
    </div>
  );
}

// ── the grid ───────────────────────────────────────────────────────────────────────────

function GainTick({ db, limits }: { db: number; limits: Limits }) {
  const zero = gainNorm(0, limits) * 100, v = gainNorm(db, limits) * 100;
  const lo = Math.min(zero, v), hi = Math.max(zero, v);
  return (
    <i className="g" aria-hidden="true">
      {hi - lo > 0.2 && <i className={`f${v < zero ? " cut" : ""}`} style={{ left: `${lo.toFixed(1)}%`, width: `${(hi - lo).toFixed(1)}%` }} />}
      <i className="z" style={{ left: `${zero.toFixed(1)}%` }} />
    </i>
  );
}

type LaneFn = (note: number, what: "mute" | "solo") => void;

/** M and S for the lane at a note: quiet until hovered or one is on. */
function LaneButtons({ name, note, lane, onLane }: { name: string; note: number; lane: LaneState; onLane: LaneFn }) {
  return (
    <span className="ms">
      <button type="button" className={`m${lane.muted ? " on" : ""}`} aria-pressed={lane.muted} data-testid="pp-sampler-m"
        aria-label={`Mute ${name}`} title={lane.muted ? "Unmute" : "Mute (the lane at this note)"}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => onLane(note, "mute")}>M</button>
      <button type="button" className={`s${lane.solo ? " on" : ""}`} aria-pressed={lane.solo} data-testid="pp-sampler-s"
        aria-label={`Solo ${name}`} title={lane.solo ? "Unsolo" : "Solo (silences the other pads)"}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => onLane(note, "solo")}>S</button>
    </span>
  );
}

type CellProps = {
  s: SamplerSound; lane: LaneState; limits: Limits; selected: boolean; pressed: boolean; over: boolean;
  flash: number; gainDb: number; readOnly: boolean;
  onPress: (s: SamplerSound) => void; onLane: LaneFn;
  dropProps: DropProps;
};

function PadCell({ s, lane, limits, selected, pressed, over, flash, gainDb, readOnly, onPress, onLane, dropProps }: CellProps) {
  // Dimmed when the engine has parked it, whatever the lane lists say (a second sampler is
  // never parked; a lane both muted and soloed plays).
  const quiet = s.silenced;
  const words = laneWords(s, lane);
  const label = `${s.name}, ${s.mode === "drum" ? noteName(s.pitch) : `${rangeText(s)}, root ${noteName(s.pitch)}`}`
    + `${s.missing ? ", file missing" : ""}${words ? `, ${words}` : ""}`;
  const tip = [
    `${s.name} · ${s.mode === "drum" ? noteName(s.pitch) : `${rangeText(s)}, root ${noteName(s.pitch)}`} · ${fmtLevel(gainDb)}`,
    s.missing ? `File not found: ${s.path || s.file}` : "",
    readOnly ? "" : "Click to hear and edit. Drop a sample to replace.",
  ].filter(Boolean).join("\n");
  return (
    <div className={`pp-sampler-cell${quiet ? " quiet" : ""}${s.missing ? " missing" : ""}${over ? " over" : ""}${s.mode !== "drum" ? " keys" : ""}`}
      data-testid="pp-sampler-cell" data-note={s.pitch} data-sound={soundKey(s)} {...(readOnly ? {} : dropProps)}>
      <button type="button" className={`pad${pressed ? " pressed" : ""}`} aria-current={selected || undefined} aria-label={label}
        title={tip} disabled={readOnly}
        onPointerDown={(e) => { if (e.button === 0 && !readOnly) onPress(s); }}
        onClick={(e) => { if (e.detail === 0 && !readOnly) onPress(s); }}>
        <i className="fl" data-testid={flash > 0 ? "pp-sampler-flash" : undefined} style={{ opacity: flash.toFixed(2) }} />
        <span className="n">{s.missing ? "missing" : <>{noteName(s.pitch)}{s.mode !== "drum" && <KeysGlyph />}</>}</span>
        <span className="nm">{s.name}</span>
        <GainTick db={gainDb} limits={limits} />
      </button>
      {!readOnly && <LaneButtons name={s.name} note={s.pitch} lane={lane} onLane={onLane} />}
    </div>
  );
}

/** "Played across the keys": a tiny keyboard (three white keys, two black). */
function KeysGlyph() {
  return (
    <svg className="kb" width={9} height={7} viewBox="0 0 9 7" aria-hidden="true">
      <rect className="w" x={0} y={0} width={2.6} height={7} /><rect className="w" x={3.2} y={0} width={2.6} height={7} />
      <rect className="w" x={6.4} y={0} width={2.6} height={7} />
      <rect className="b" x={1.9} y={0} width={1.9} height={4.2} /><rect className="b" x={5.2} y={0} width={1.9} height={4.2} />
    </svg>
  );
}

type DropProps = {
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
};

// ── the melodic view's pictures ────────────────────────────────────────────────────────

/** The file's real waveform (file_peaks), or nothing: a missing or unresolved file shows
 *  only its name, never invented peaks. Dimmed while the engine has the sound parked. */
function Wave({ s, run, flash }: { s: SamplerSound; run?: RunCommand; flash: number }) {
  const path = s.path && !s.missing ? s.path : null;
  const peaks = usePeaks(path, run);
  const d = peaks ? peaksArea(peaks, WAVE_W, WAVE_H) : "";
  return (
    <svg className={`pp-plot pp-sampler-wave${s.silenced ? " quiet" : ""}`} data-testid="pp-sampler-wave" viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} width={WAVE_W} height={WAVE_H}
      role="img" aria-label={peaks ? `Waveform of ${s.name}` : s.missing ? `${s.name}: file missing` : `${s.name}: no waveform`}>
      <line className="zero" x1={0} x2={WAVE_W} y1={WAVE_H / 2} y2={WAVE_H / 2} />
      {d && <path className="w" data-testid="pp-sampler-peaks" d={d} style={{ opacity: (0.75 + 0.25 * flash).toFixed(2) }} />}
      {!d && (
        <text className={`axis${s.missing ? " warn" : ""}`} x={WAVE_W / 2} y={WAVE_H / 2 + 3} textAnchor="middle" data-testid="pp-sampler-nowave">
          {s.missing ? `missing: ${fileName(s.path || s.file)}` : path ? "" : fileName(s.file || s.name)}
        </text>
      )}
    </svg>
  );
}

/** All 128 keys: the sound's range lit, its root marked under the strip, the keys held at the
 *  sampler right now (from the rail) and this frame's hits lit. */
function KeyStrip({ s, held, hits }: { s: SamplerSound; held: ReadonlySet<number>; hits: ReadonlyMap<number, MeterFlash> }) {
  const keys = pianoKeys(0, 127, WAVE_W);
  const root = keyCentre(keys, s.pitch) ?? 0;
  const labelLeft = root > WAVE_W - 24;
  const cls = (n: number, black: boolean) => {
    const inRange = n >= s.minNote && n <= s.maxNote;
    const lit = held.has(n) || hits.has(n);
    return `k ${black ? "b" : "w"}${inRange ? " in" : " out"}${lit ? " lit" : ""}${n === s.pitch ? " root" : ""}`;
  };
  return (
    <svg className="pp-sampler-keys" data-testid="pp-sampler-keys" viewBox={`0 0 ${WAVE_W} ${KEYS_H + 9}`} width={WAVE_W} height={KEYS_H + 9}
      role="img" aria-label={`Plays ${rangeText(s)}, root ${noteName(s.pitch)}${held.size ? `; held: ${[...held].map(noteName).join(", ")}` : ""}`}>
      {keys.filter((k) => !k.black).map((k) => (
        <rect key={k.note} className={cls(k.note, false)} data-note={k.note} x={k.x.toFixed(2)} y={0} width={Math.max(0.5, k.w - 0.4).toFixed(2)} height={KEYS_H} />
      ))}
      {keys.filter((k) => k.black).map((k) => (
        <rect key={k.note} className={cls(k.note, true)} data-note={k.note} x={k.x.toFixed(2)} y={0} width={k.w.toFixed(2)} height={KEYS_H * 0.62} />
      ))}
      <path className="caret" d={`M${root.toFixed(2)} ${KEYS_H + 1} l3 4 h-6 z`} />
      <text className="axis rootlbl" x={labelLeft ? root - 5 : root + 5} y={KEYS_H + 8} textAnchor={labelLeft ? "end" : "start"}>
        {`root ${noteName(s.pitch)}`}
      </text>
    </svg>
  );
}

// ── the kit menu ───────────────────────────────────────────────────────────────────────

type KitInfo = { id: string; name: string; available: boolean };

/** The kit library, fetched when this row opens (never earlier). Loading one replaces every
 *  sound, which the row says before anything is clicked. */
function KitRow({ run, current, count, onDone }: { run: RunCommand; current?: string; count: number; onDone: () => void }) {
  const [kits, setKits] = useState<KitInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    let dead = false;
    runRef.current("list_drum_kits", {}).then((r) => {
      if (dead) return;
      if (r.ok && r.data) setKits(r.data.kits.map((k) => ({ id: k.id, name: k.name, available: k.available })));
      else setFailed(true);
    }, () => { if (!dead) setFailed(true); });
    return () => { dead = true; };
  }, []);
  return (
    <div className="pp-sampler-slot pp-sampler-kits" data-testid="pp-sampler-kits" role="group" aria-label="Load a kit">
      <div className="msg">
        <span className="t">{kits === null ? (failed ? "Kits unavailable" : "Loading kits…") : "Load a kit"}</span>
        <span className="d">{count > 0 ? `Replaces all ${count} sound${count === 1 ? "" : "s"} on this sampler.` : "Loads its pads onto this sampler."}</span>
      </div>
      <div className="acts">
        {kits?.map((k) => (
          <button key={k.id} type="button" className="pp-btn" data-testid="pp-sampler-kit" data-kit={k.id} disabled={!k.available}
            aria-pressed={k.id === current} title={k.available ? `Load ${k.name}` : `${k.name}: its files are not installed`}
            onClick={() => { void run("load_drum_kit", { kit: k.id }); onDone(); }}>{k.name}</button>
        ))}
        <button type="button" className="pp-btn ghost" data-testid="pp-sampler-cancel" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────────────────

function useNotice(): [string | null, (text: string | null) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const t = setTimeout(() => setText(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [text]);
  return [text, setText];
}

/** The live frame for this sampler (hits, held keys, what it adds), or undefined (idle). */
function useSamplerMeter(trackId: string, plugin: PanelProps["plugin"]) {
  const meter = usePluginMeter<SamplerMeter>(trackId, plugin.index, { type: "sampler", itemId: plugin.itemId });
  const hits = useMeterEvents(meter, "hits");
  return { meter, hits };
}

function SamplerPanel({ plugin, trackId, track, run }: PanelProps) {
  const sounds = soundsOf(plugin);
  const limits = limitsOf(plugin);
  const primary = plugin.sampler?.primary !== false;
  const readOnly = !primary || !run;
  const { meter, hits } = useSamplerMeter(trackId, plugin);
  const [selected, setSelected] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [previewGain, setPreviewGain] = useState<{ key: string; db: number } | null>(null);
  const [notice, setNotice] = useNotice();
  // A refused drop: said where it has room to be read (the row's place), not in the top row.
  const [refusal, setRefusal] = useNotice();
  const [melodicIndex, setMelodicIndex] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);
  // The selected pad's Level while it is being dragged, so its cell's gain tick follows.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onPreviewGain = useCallbackRef((db: number | null) => {
    setPreviewGain((p) => (db === null ? (p === null ? p : null) : { key: selectedRef.current ?? "", db }));
  });

  if (!sounds) {
    return (
      <div className="pp-sampler" data-testid="pp-sampler">
        <div className="set-hint" data-testid="pp-sampler-old-engine">This sampler's sounds need the updated Mosh engine.</div>
      </div>
    );
  }

  const sorted = sortSounds(sounds);
  const view = viewOf(sounds);
  const kit = plugin.sampler?.kit;
  const held = new Set(meter?.held ?? []);

  const audition = async (pitch: number) => {
    const r = runRef.current;
    if (!r) return;
    try {
      const res = await r("audition_note", { pitch, velocity: AUDITION_VELOCITY, action: "blip" });
      if (res.ok && res.data && !res.data.audible) setNotice(`Not heard: ${res.data.reason ?? "no audio path"}`);
    } catch { /* the store reports a failed command */ }
  };
  const press = (s: SamplerSound) => {
    const key = soundKey(s);
    setSelected(key);
    setRefusal(null);
    if (slot?.kind !== "kits") setSlot(null);
    setPressed(key);
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setPressed(null), PRESS_MS);
    void audition(s.pitch);
  };
  // Lanes reach only the track's first sampler: a second one shows none.
  const laneFor = (s: Pick<SamplerSound, "pitch">) => (primary ? laneOf(s, track) : NO_LANE);
  const lane: LaneFn = (note, what) => {
    const l = laneOf({ pitch: note }, track);
    void run?.("set_drum_lane", what === "mute" ? { note, mute: !l.muted } : { note, solo: !l.solo });
  };
  // A solo on a note no sound is rooted on (its pad cleared, or set in the step sequencer)
  // silences every sound here while no cell shows a lit S: named in the top row, one click off.
  const orphanSolo = readOnly ? [] : orphanLanes(sounds, track).solo;
  const unsoloOrphans = () => { for (const note of orphanSolo) void run?.("set_drum_lane", { note, solo: false }); };
  const assign = async (note: number, path: string, mode: Mode) => {
    const r = runRef.current;
    if (!r) return;
    setSlot(null);
    try {
      const res = await r("assign_sample", { note, file: path, mode });
      const imported = importedFilePath(res);
      if (imported) addRecentSample(imported);
    } catch { /* the store reports a failed command */ }
  };
  /** A sample for `note` (dropped `onto` a sound, or on an empty cell): straight in when it
   *  replaces nothing, else asked first. */
  const offer = (note: number, path: string, mode: Mode, onto?: SamplerSound) => {
    const replaced = replacedBy(sounds, note, onto);
    if (replaced.length === 0) void assign(note, path, mode);
    else setSlot({ kind: "confirm", note, path, mode, replaced, onto });
  };
  /** A sample dropped on a sound: its own kind at its root (a range sound becomes a pad). */
  const offerOnto = (s: SamplerSound, path: string) => offer(s.pitch, path, s.mode === "melodic" ? "melodic" : "drum", s);
  const dropOn = (key: string, onPath: (path: string) => void): DropProps => ({
    onDragOver: (e) => {
      if (!dragCarriesSample(e.dataTransfer?.types)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (over !== key) setOver(key);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((k) => (k === key ? null : k));
    },
    onDrop: (e) => {
      if (!dragCarriesSample(e.dataTransfer?.types)) return;
      // Ours: the app-wide drop (which imports a clip onto the timeline) must not also take it.
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      const src = droppedSample(e.dataTransfer);
      if (src.path !== null) { onPath(src.path); return; }
      setRefusal(src.reason === "no-path"
        ? "Finder drops carry no file path here. Drag the sample from Browser › Files."
        : "Drop an audio file.");
    },
  });
  const choose = async (onPath: (path: string) => void) => {
    try {
      const r = await pickFiles({ filters: "*.wav;*.aif;*.aiff;*.flac;*.mp3", title: "Choose a sample" });
      const path = r.ok ? r.files[0] : undefined;
      if (path) onPath(path);
    } catch { /* no picker */ }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    if (refusal) setRefusal(null);
    else if (slot) setSlot(null);
    else if (selected) setSelected(null);
    else return;
    e.stopPropagation();
  };

  const selectedSound = sorted.find((s) => soundKey(s) === selected) ?? null;

  const kitButton = !readOnly && (
    <button type="button" className="pp-btn pp-sampler-kitbtn" data-testid="pp-sampler-kitbtn" aria-expanded={slot?.kind === "kits"}
      title="Load a kit (replaces every sound)" onClick={() => setSlot(slot?.kind === "kits" ? null : { kind: "kits" })}>
      {kit ? kit.replace(/-/g, " ") : "Kit"} <span aria-hidden="true">▾</span>
    </button>
  );
  const outBar = (
    <span className="pp-sampler-out" title="What the sampler adds (its own sounds), peak">
      <span className="k">out</span>
      <MeterBar value={meter ? meter.outDb : undefined} min={-60} max={0} label="Sampler output"
        valueText={meter ? `${meter.outDb.toFixed(1)} dBFS` : "No signal"} testId="pp-sampler-outbar" />
    </span>
  );
  const orphanText = notesText(orphanSolo);
  const top = (hint: string) => (
    <div className="pp-sampler-top">
      {kitButton}
      {!notice && orphanSolo.length > 0 ? (
        <span className="pp-sampler-lanes" data-testid="pp-sampler-orphan-solo"
          title={`${orphanText} ${orphanSolo.length === 1 ? "is" : "are"} soloed with no sound of its own there, so every sound on this sampler is silent`}>
          <span className="t">{`Solo on empty ${orphanText}`}</span>
          <button type="button" className="pp-btn" data-testid="pp-sampler-unsolo" onClick={unsoloOrphans}>Unsolo</button>
        </span>
      ) : (
        <span className={`pp-sampler-hint${notice ? " notice" : ""}`} data-testid="pp-sampler-hint" role={notice ? "status" : undefined}
          title={notice ?? hint}>{notice ?? hint}</span>
      )}
      {outBar}
    </div>
  );
  const slotView = (): ReactNode => {
    if (slot?.kind === "kits" && run) return <KitRow run={run} current={kit} count={sounds.length} onDone={() => setSlot(null)} />;
    if (slot?.kind === "confirm") {
      const t = replaceText(slot.replaced, fileName(slot.path), { note: slot.note, mode: slot.mode, onto: slot.onto });
      return (
        <div className="pp-sampler-slot pp-sampler-confirm" data-testid="pp-sampler-confirm" role="alertdialog" aria-label={t.title}>
          <div className="msg"><span className="t">{t.title}</span><span className="d">{t.detail}</span></div>
          <div className="acts">
            <button type="button" className="pp-btn on" data-testid="pp-sampler-replace"
              onClick={() => void assign(slot.note, slot.path, slot.mode)}>Replace</button>
            <button type="button" className="pp-btn ghost" data-testid="pp-sampler-cancel" onClick={() => setSlot(null)}>Cancel</button>
          </div>
        </div>
      );
    }
    if (refusal && !slot) {
      return (
        <div className="pp-sampler-slot pp-sampler-refusal" data-testid="pp-sampler-refusal" role="status">
          <div className="msg"><span className="t">Can't load that file here</span><span className="d">{refusal}</span></div>
          <button type="button" className="pp-btn ghost" onClick={() => setRefusal(null)}>OK</button>
        </div>
      );
    }
    if (slot?.kind === "choose") {
      return (
        <div className="pp-sampler-slot pp-sampler-confirm" data-testid="pp-sampler-choose" role="group" aria-label={`Load ${fileName(slot.path)}`}>
          <div className="msg"><span className="t">{fileName(slot.path)}</span><span className="d">Play it as one pad, or across the keys?</span></div>
          <div className="acts">
            <button type="button" className="pp-btn on" data-testid="pp-sampler-as-pad"
              title={`A one-shot on ${noteName(FIRST_PAD_NOTE)}`}
              onClick={() => offer(FIRST_PAD_NOTE, slot.path, "drum")}>{`Pad ${noteName(FIRST_PAD_NOTE)}`}</button>
            <button type="button" className="pp-btn" data-testid="pp-sampler-as-keys"
              title={`Repitched across the keyboard, played at its own pitch on ${noteName(DEFAULT_ROOT)}; a note's length gates it`}
              onClick={() => offer(DEFAULT_ROOT, slot.path, "melodic")}>{`Keys · ${noteName(DEFAULT_ROOT)}`}</button>
            <button type="button" className="pp-btn ghost" data-testid="pp-sampler-cancel" onClick={() => setSlot(null)}>Cancel</button>
          </div>
        </div>
      );
    }
    return null;
  };

  // ── empty ──
  if (view === "empty") {
    const body = dropOn("empty", (path) => setSlot({ kind: "choose", path }));
    return (
      <div className="pp-sampler" data-testid="pp-sampler" data-view="empty" onKeyDown={onKeyDown}>
        <div className={`pp-sampler-empty${over === "empty" ? " over" : ""}`} data-testid="pp-sampler-empty" {...(readOnly ? {} : body)}>
          <span className="t">{readOnly ? "Empty" : "Drop a sample or load a kit"}</span>
          {!readOnly && (
            <span className="acts">
              <button type="button" className="pp-btn" data-testid="pp-sampler-loadkit" aria-expanded={slot?.kind === "kits"}
                onClick={() => setSlot(slot?.kind === "kits" ? null : { kind: "kits" })}>Load kit…</button>
              <button type="button" className="pp-btn" data-testid="pp-sampler-pick"
                onClick={() => void choose((path) => setSlot({ kind: "choose", path }))}>Choose file…</button>
            </span>
          )}
          {(refusal ?? notice) && <span className="pp-sampler-hint notice" role="status" data-testid="pp-sampler-empty-notice">{refusal ?? notice}</span>}
          {readOnly && <span className="pp-sampler-hint">Read-only: pads are edited on this track's first sampler</span>}
        </div>
        {refusal ? null : slotView()}
      </div>
    );
  }

  // ── melodic ──
  if (view === "melodic") {
    const keysSounds = sorted;
    const idx = Math.min(melodicIndex, keysSounds.length - 1);
    const s = keysSounds[idx]!;
    const flash = soundFlash(s, hits);
    const replaceWith = (path: string) => offerOnto(s, path);
    return (
      <div className={`pp-sampler${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-sampler" data-view="melodic" onKeyDown={onKeyDown}>
        {top(readOnly ? "Read-only: edit the first sampler" : !plugin.enabled ? "Off: turn it on to hear it" : "Played across the keys")}
        {keysSounds.length > 1 && (
          <div className="pp-seg pp-sampler-which" role="group" aria-label="Sound">
            {keysSounds.map((k, i) => (
              <button key={soundKey(k)} type="button" aria-pressed={i === idx} onClick={() => setMelodicIndex(i)}>{k.name}</button>
            ))}
          </div>
        )}
        <div className={`pp-sampler-melodic${over === "melodic" ? " over" : ""}`} {...(readOnly ? {} : dropOn("melodic", replaceWith))}>
          <Wave s={s} run={run} flash={flash} />
          <KeyStrip s={s} held={held} hits={hits} />
        </div>
        {slotView() ?? (
          <SoundRow key={soundKey(s)} s={s} lane={laneFor(s)} limits={limits} run={run} readOnly={readOnly} showMute={primary}
            onPreviewGain={noPreview} onCleared={() => setMelodicIndex(0)} />
        )}
      </div>
    );
  }

  // ── drum ──
  const emptyNotes = readOnly ? [] : freeSlotNotes(sounds, emptyCellCount(sorted.length));
  const below = slotView() ?? (selectedSound && (
    <SoundRow key={soundKey(selectedSound)} s={selectedSound} lane={laneFor(selectedSound)} limits={limits} run={run}
      readOnly={readOnly} showMute={false} onPreviewGain={onPreviewGain} onCleared={() => setSelected(null)} />
  ));
  return (
    <div className={`pp-sampler${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-sampler" data-view="drum" onKeyDown={onKeyDown}>
      {top(readOnly ? "Read-only: edit the first sampler" : !plugin.enabled ? "Off: turn it on to hear taps" : "Tap to hear · drop to swap")}
      <SoundGrid tight={!!below} selected={selected} cells={sorted.length + emptyNotes.length}>
        {sorted.map((s) => {
          const key = soundKey(s);
          const gainDb = previewGain && previewGain.key === key ? previewGain.db : s.userGainDb;
          return (
            <PadCell key={key} s={s} lane={laneFor(s)} limits={limits} selected={key === selected} pressed={key === pressed}
              over={over === key} flash={soundFlash(s, hits)} gainDb={gainDb} readOnly={readOnly}
              onPress={press} onLane={lane}
              dropProps={dropOn(key, (path) => offerOnto(s, path))} />
          );
        })}
        {emptyNotes.map((note) => {
          const key = `empty-${note}`;
          const toNote = (path: string) => offer(note, path, "drum");
          // A lane left on this note (its pad cleared while muted or soloed) keeps its M/S here.
          const l = laneOf({ pitch: note }, track);
          const laneOn = l.muted || l.solo;
          return (
            <div key={key} className={`pp-sampler-cell empty${over === key ? " over" : ""}`} data-testid="pp-sampler-slot" data-note={note}
              {...dropOn(key, toNote)}>
              <button type="button" className="pad"
                aria-label={`Empty pad ${noteName(note)}${l.solo ? ", soloed" : l.muted ? ", muted" : ""}: choose a sample`}
                title={`Drop a sample here for ${noteName(note)} (or click to choose a file)`}
                onClick={() => void choose(toNote)}>
                <span className="n">{noteName(note)}</span>
                <span className="nm">empty</span>
              </button>
              {laneOn && <LaneButtons name={`empty ${noteName(note)}`} note={note} lane={l} onLane={lane} />}
            </div>
          );
        })}
      </SoundGrid>
      {below}
    </div>
  );
}

/** The drum grid: up to three rows of cells, two while a row is open under it (so the panel
 *  stays compact), scrolling past that. An edge that hides cells fades, so a hidden pad is
 *  never simply gone; the selected cell is scrolled into view when the grid tightens. */
function SoundGrid({ tight, selected, cells, children }: { tight: boolean; selected: string | null; cells: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState<GridEdge>("");
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const e = gridEdge(el.scrollTop, el.scrollHeight, el.clientHeight);
    setEdge((p) => (p === e ? p : e));
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cell = selected ? [...el.querySelectorAll<HTMLElement>(".pp-sampler-cell[data-sound]")].find((c) => c.dataset.sound === selected) : undefined;
    if (cell) el.scrollTop = scrollToShow(el.scrollTop, el.clientHeight, cell.offsetTop, cell.offsetHeight);
    measure();
  }, [tight, selected, cells, measure]);
  return (
    <div ref={ref} className={`pp-sampler-grid${tight ? " tight" : ""}`} data-testid="pp-sampler-grid" data-more={edge || undefined}
      role="group" aria-label="Sounds" onScroll={measure}>
      {children}
    </div>
  );
}

const noPreview = () => {};

/** A stable callback that always calls the latest `fn` (so a child's effect can depend on it). */
function useCallbackRef<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

// ── minimized ──────────────────────────────────────────────────────────────────────────

const MINI_W = 44, MINI_H = 14;

/** The minimized row's thumbnail: one dot per sound in note order (a dash for a sound played
 *  across the keys), lit by the rail's hits, faint while the engine has the sound parked. */
function SamplerMini({ plugin, trackId, run }: PanelProps) {
  const { hits } = useSamplerMeter(trackId, plugin);
  const sounds = sortSounds(soundsOf(plugin) ?? []);
  // A sampler holding one sound played across the keys: that sound's own waveform (real
  // peaks, the panel's cached fetch; none → its dash), lit by hits.
  const single = sounds.length === 1 && viewOf(sounds) === "melodic" ? sounds[0]! : null;
  const peaks = usePeaks(single && single.path && !single.missing ? single.path : null, run);
  if (single && peaks) {
    const lit = soundFlash(single, hits);
    return (
      <svg className={`pp-sampler-mini${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-sampler-mini" width={MINI_W} height={MINI_H}
        viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
        <path className={`w${lit > 0 ? " lit" : ""}${single.silenced ? " quiet" : ""}`} d={peaksArea(peaks, MINI_W, MINI_H)}
          style={lit > 0 ? { opacity: (0.45 + 0.55 * lit).toFixed(2) } : undefined} />
      </svg>
    );
  }
  const dots = miniDots(sounds.length, MINI_W, MINI_H);
  return (
    <svg className={`pp-sampler-mini${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-sampler-mini" width={MINI_W} height={MINI_H}
      viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
      {sounds.length === 0 && <line className="none" x1={2} x2={MINI_W - 2} y1={MINI_H / 2} y2={MINI_H / 2} />}
      {dots.map((p, i) => {
        const s = sounds[i]!;
        const lit = soundFlash(s, hits);
        const cls = `d${lit > 0 ? " lit" : ""}${s.silenced ? " quiet" : ""}${s.missing ? " missing" : ""}`;
        const r = sounds.length > 8 ? 1.7 : 2.2;
        return s.mode === "drum"
          ? <circle key={soundKey(s)} className={cls} cx={p.cx.toFixed(2)} cy={p.cy.toFixed(2)} r={r} style={lit > 0 ? { opacity: (0.45 + 0.55 * lit).toFixed(2) } : undefined} />
          : <rect key={soundKey(s)} className={cls} x={(p.cx - 3).toFixed(2)} y={(p.cy - 1).toFixed(2)} width={6} height={2} rx={1}
            style={lit > 0 ? { opacity: (0.45 + 0.55 * lit).toFixed(2) } : undefined} />;
      })}
    </svg>
  );
}

export const samplerPanelDef: PanelDef = {
  Panel: SamplerPanel,
  summary: (plugin, ctx) => samplerSummary(plugin, ctx?.track),
  Mini: SamplerMini,
};
