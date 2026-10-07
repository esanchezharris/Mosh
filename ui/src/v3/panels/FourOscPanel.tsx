import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useStore } from "../../store";
import type { FourOscMeter, Plugin } from "../../types";
import { PresetPicker } from "../../ui/PresetPicker";
import { usePresetMemory } from "../presetMemory";
import { Dial } from "./Dial";
import { DragNode } from "./DragNode";
import { chainDb, logFreqs, plotTopHz } from "./dsp";
import {
  DELAY_MAX_SEC, DELAY_NOTES, ENV_PLOT, FILTER_LONG, FILTER_SHORT, FILTER_TYPES, FX_LABEL, FX_NAME, FX_ORDER, FX_STATE,
  WAVES, WAVE_LABEL, WAVE_MENU, addOscLevelDb, ampAdsr, ampAnalogOf, baseCutoffHz, clampCutoffHz, ctl, delayBeatsOf, delayNote,
  delaySeconds, envDragTime, envGeometry, envPeakNote, filterChain, filterSlopeOf, filterTypeOf, fmtCents, fmtCutoff, fmtFrac,
  fmtLevel, fmtLevelBare, fmtModDepth, fmtPan, fmtPct100, fmtSignedPct, fmtSt, fmtTime, fourOscSummary, fxOn, hasFullContract,
  hasState, hzToNote, isSilentLevel, keyStrip, loadSection, modSourceLabel, noteName, normAt, paramLabel, physAt, resonanceQ,
  reverbDryDb, saveSection, stripRange, sustainAtY, voicesOf, waveOf,
  type Adsr, type Ctl, type EnvBox, type FilterType, type FxKey, type Section, type Wave,
} from "./fourosc";
import { GenericParams } from "./GenericParams";
import { newGestureId } from "./gesture";
import { MeterBar, meterFill, useMeterEvents, usePluginMeter } from "./meters";
import { clamp, fmtDb } from "./params";
import { clientToSvg, curvePath, fillPath, freqScale, linScale } from "./plot";
import type { PanelDef, PanelProps } from "./types";
import { useDragSend } from "./useDragSend";

type SetParam = PanelProps["setParam"];
type SetState = PanelProps["setState"];

const SECTION_LABEL: Record<Section, string> = { osc: "Osc", amp: "Amp", filter: "Filter", fx: "FX", mod: "Mod" };
const SECTION_NAME: Record<Section, string> = {
  osc: "Oscillators", amp: "Amp envelope", filter: "Filter", fx: "Effects", mod: "Modulation routes (read-only)",
};
/** A burst of keys or wheel notches builds on the value it last sent, not on a snapshot whose
 *  patch may not have arrived between two key repeats. */
const BURST_MS = 600;
/** The output bar's scale (dBFS). */
const OUT_FLOOR_DB = -60;

/** Every key a control handles stops at the panel: the app's shortcut router listens on the
 *  window and does not skip a focused slider (Home would move the playhead, an arrow nudge
 *  the selected clips). */
const stop = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); };

/** The keys the shortcut router binds that a focused control here means for itself. */
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
/** On the panel's root: a focused plain button (an oscillator chip, an effect's switch) keeps
 *  the arrows, Home/End and PageUp/Down from the router, which would nudge the selected clips
 *  or move the playhead. Space and Enter, and the modified keys, pass. */
const keepNavKeys = (e: KeyboardEvent<HTMLDivElement>) => {
  if (!NAV_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement).tagName === "BUTTON") e.stopPropagation();
};

/** Where a key moves the choice in a row of `n` options from `at` (the arrows wrap; Home and
 *  End go to the ends), or null for any other key. */
function segKeyTarget(key: string, at: number, n: number): number | null {
  switch (key) {
    case "ArrowRight": case "ArrowDown": return (at + 1) % n;
    case "ArrowLeft": case "ArrowUp": return (at + n - 1) % n;
    case "Home": return 0;
    case "End": return n - 1;
    default: return null;
  }
}

/** The usual slider keys as a new 0-1 position, or null for any other key. */
function keyStep(e: KeyboardEvent, norm: number): number | null {
  const fine = e.shiftKey ? 0.2 : 1;
  switch (e.key) {
    case "ArrowUp": case "ArrowRight": return norm + 0.01 * fine;
    case "ArrowDown": case "ArrowLeft": return norm - 0.01 * fine;
    case "PageUp": return norm + 0.1;
    case "PageDown": return norm - 0.1;
    case "Home": return 0;
    case "End": return 1;
    default: return null;
  }
}

// ── a scrubbable read-out (the family's EQ-style value: drag up/down, keys, wheel) ─────────

function Scrub({ c, label, caption, fmt, valueText, onChange, quantize, testId, className, title, inert, onPress, children }: {
  c: Ctl; label: string; caption?: string;
  fmt: (phys: number) => string; valueText?: (phys: number) => string;
  onChange: (norm: number, gesture: string) => void;
  quantize?: (norm: number) => number;
  testId?: string; className?: string; title?: string;
  /** Adjustable but without effect right now (say why in `title`). */
  inert?: boolean;
  /** Called on press (e.g. to focus the oscillator a level belongs to). */
  onPress?: () => void;
  children?: ReactNode;
}) {
  const drag = useDragSend<number>((v, g) => onChange(v, g));
  const start = useRef<{ y: number; v: number } | null>(null);
  const last = useRef<{ v: number; at: number } | null>(null);
  const q = (v: number) => { const x = clamp(v, 0, 1); return quantize ? quantize(x) : x; };
  const shown = drag.live ?? c.norm;
  const phys = physAt(c.range, shown);
  const base = () => (last.current && Date.now() - last.current.at < BURST_MS ? last.current.v : c.norm);
  const nudge = (v: number) => {
    const n = q(v);
    if (Math.abs(n - c.norm) < 1e-9 && (!last.current || Date.now() - last.current.at >= BURST_MS)) return;
    last.current = { v: n, at: Date.now() };
    drag.nudge(n);
  };
  // The wheel turns the value and must not also scroll the inspector: a non-passive native
  // listener (React's onWheel cannot preventDefault). Trackpad deltas sum into notches.
  const ref = useRef<HTMLSpanElement>(null);
  const wheel = useRef({ acc: 0, nudge, base });
  wheel.current.nudge = nudge;
  wheel.current.base = base;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
      if (delta === 0 || e.ctrlKey) return;
      e.preventDefault();
      const w = wheel.current;
      w.acc += e.deltaMode === 1 ? delta * 33 : e.deltaMode === 2 ? delta * 400 : delta;
      const notches = Math.trunc(w.acc / 100);
      if (notches === 0) return;
      w.acc -= notches * 100;
      w.nudge(w.base() - notches * (e.shiftKey ? 0.002 : 0.01));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const text = fmt(phys);
  return (
    <span className={`pp-fo-scrub${inert ? " inert" : ""}${className ? ` ${className}` : ""}`} title={title}>
      {caption && <span className="cap" aria-hidden="true">{caption}</span>}
      <span ref={ref} className="v" role="slider" tabIndex={c.present ? 0 : -1} data-testid={testId}
        aria-label={label} aria-valuemin={c.range.min} aria-valuemax={c.range.max} aria-valuenow={Number(phys.toFixed(3))}
        aria-valuetext={valueText ? valueText(phys) : text} aria-disabled={c.present ? undefined : true}
        onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
          onPress?.();
          if (e.button !== 0 || !c.present) return;
          e.preventDefault();
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          (e.currentTarget as HTMLElement).focus();
          start.current = { y: e.clientY, v: shown };
          drag.begin();
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          drag.update(q(start.current.v + (start.current.y - e.clientY) / (e.shiftKey ? 600 : 150)));
        }}
        onPointerUp={() => { if (start.current) { start.current = null; drag.end(); } }}
        onPointerCancel={() => { if (start.current) { start.current = null; drag.end(); } }}
        onLostPointerCapture={() => { if (start.current) { start.current = null; drag.end(); } }}
        onKeyDown={(e) => {
          if (!c.present) return;
          const t = keyStep(e, base());
          if (t === null) return;
          stop(e);
          nudge(t);
        }}
        onDoubleClick={() => { if (c.present) nudge(c.defNorm); }}>
        {text}
      </span>
      {children}
    </span>
  );
}

/** A Dial bound to one 4OSC parameter. */
function ParamDial({ c, label, fmt, setParam, bipolar, origin, quantize, inert, title, testId }: {
  c: Ctl; label: string; fmt: (phys: number) => string; setParam: SetParam;
  bipolar?: boolean; origin?: number; quantize?: (norm: number) => number; inert?: boolean; title?: string; testId?: string;
}) {
  return (
    <Dial label={label} norm={c.norm} display={fmt(c.phys)} defaultNorm={c.defNorm} bipolar={bipolar} origin={origin}
      quantize={quantize} disabled={!c.present} inert={inert} title={title} testId={testId}
      onChange={(v, gesture) => setParam(c.index, v, { gesture })} />
  );
}

/** dB for a dial: one decimal near 0, whole dB from -10 down ("-4.5 dB", "-24 dB", "-100 dB"). */
const fmtDbShort = (db: number): string => fmtDb(db, Math.abs(db) >= 9.95 ? 0 : 1);

const quantizeTo = (c: Ctl) => (norm: number) => normAt(c.range, physAt(c.range, norm));

// ── the top row ────────────────────────────────────────────────────────────────────────

function SectionSeg({ sections, value, lit, onChange }: {
  sections: Section[]; value: Section; lit: Partial<Record<Section, boolean>>; onChange: (s: Section) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segKeyTarget(e.key, sections.indexOf(value), sections.length);
    if (to === null) return;
    stop(e);
    onChange(sections[to]!);
    refs.current[to]?.focus();
  };
  return (
    <div className="pp-seg pp-fo-sections" role="radiogroup" aria-label="Section" onKeyDown={onKey}>
      {sections.map((s, i) => (
        <button key={s} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={value === s}
          tabIndex={value === s ? 0 : -1} title={SECTION_NAME[s]} data-testid={`pp-fo-section-${s}`}
          className={lit[s] ? "live" : undefined} onClick={() => onChange(s)}>{SECTION_LABEL[s]}</button>
      ))}
    </div>
  );
}

/** A setting with a few choices (the filter's type, its slope) as a radio group: a click
 *  picks one; the arrows (and Home/End) move the choice and the focus together and stop at
 *  the panel, so they never nudge clips or move the playhead. Each click is one undo step,
 *  and so is a burst of keys (one gesture). */
function SettingSeg<T extends string | number>({ label, className, options, value, disabled, onPick, text, name, title, testId }: {
  label: string; className: string; options: readonly T[]; value: T; disabled?: boolean;
  onPick: (v: T, gesture?: string) => void;
  text: (v: T) => string; name: (v: T) => string; title: (v: T) => string; testId: (v: T) => string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // A burst builds on the choice it last sent, not on a snapshot that may not have caught up.
  const burst = useRef<{ v: T; gesture: string; at: number } | null>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const live = burst.current && Date.now() - burst.current.at < BURST_MS ? burst.current : null;
    const from = live ? live.v : value;
    const to = segKeyTarget(e.key, options.indexOf(from), options.length);
    if (to === null) return;
    stop(e);
    if (disabled) return;
    refs.current[to]?.focus();
    const v = options[to]!;
    if (v === from) return;
    const gesture = live?.gesture ?? newGestureId();
    burst.current = { v, gesture, at: Date.now() };
    onPick(v, gesture);
  };
  return (
    <div className={`pp-seg ${className}`} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button key={String(o)} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={value === o}
          tabIndex={value === o ? 0 : -1} disabled={disabled} data-testid={testId(o)} aria-label={name(o)} title={title(o)}
          onClick={() => { if (value !== o) onPick(o); }}>{text(o)}</button>
      ))}
    </div>
  );
}

/** The master Level as a read-out whose underline is the live output meter. */
function MasterLevel({ plugin, trackId, setParam }: { plugin: Plugin; trackId: string; setParam: SetParam }) {
  const c = ctl(plugin, "masterLevel");
  const m = usePluginMeter<FourOscMeter>(trackId, plugin.index, { type: "4osc", itemId: plugin.itemId });
  const out = m && Number.isFinite(m.outDb) ? m.outDb : undefined;
  return (
    <Scrub c={c} label="Master level" fmt={fmtLevel} testId="pp-fo-level" className="pp-fo-master"
      title="Master level (drag, wheel or arrow keys; double-click for 0 dB). The line under it is the synth's live output."
      onChange={(v, gesture) => setParam(c.index, v, { gesture })}>
      <MeterBar value={out} min={OUT_FLOOR_DB} max={0} label="Output level" testId="pp-fo-out"
        valueText={out === undefined ? "No signal" : fmtDb(out)} />
    </Scrub>
  );
}

// ── OSC ────────────────────────────────────────────────────────────────────────────────

/** A small drawing of a wave (our own glyphs). */
function WaveGlyph({ wave }: { wave: Wave }) {
  const d: Record<Wave, string> = {
    off: "M1 5 H13",
    sine: "M1 5 C3 0.5 5 0.5 7 5 S11 9.5 13 5",
    square: "M1 8 V2 H7 V8 H13 V2",
    saw: "M1 8 L7 2 V8 L13 2 V8",
    triangle: "M1 8 L4 2 L7 8 L10 2 L13 8",
    noise: "M1 5 L2.5 2 L3.5 7 L5 3 L6 8 L7.5 1.5 L8.5 6.5 L10 3.5 L11 7 L13 4",
  };
  return <svg className="pp-fo-glyph" viewBox="0 0 14 10" width={14} height={10} aria-hidden="true"><path d={d[wave]} /></svg>;
}

function OscSection({ plugin, setParam, setState }: { plugin: Plugin; setParam: SetParam; setState: SetState }) {
  const on = [1, 2, 3, 4].filter((n) => waveOf(plugin, n) !== "off");
  const [focus, setFocus] = useState<number>(on[0] ?? 1);
  const f = on.includes(focus) ? focus : on[0];
  const firstOff = [1, 2, 3, 4].find((n) => waveOf(plugin, n) === "off");
  return (
    <div className="pp-fo-osc" data-testid="pp-fo-osc">
      <div className="pp-fo-chips" role="group" aria-label="Oscillators">
        {on.map((n) => {
          const lv = ctl(plugin, `level${n}`);
          const wave = waveOf(plugin, n);
          // At the -100 dB floor the voice's gain is exactly 0: on, but not in the sound.
          const silent = lv.present && isSilentLevel(lv.phys);
          return (
            <span key={n} className={`pp-fo-chip${f === n ? " on" : ""}${silent ? " silent" : ""}`} data-testid={`pp-fo-chip-${n}`}
              data-silent={silent ? "" : undefined}>
              <button type="button" className="pick" aria-pressed={f === n}
                title={`Oscillator ${n}: ${WAVE_LABEL[wave]}${silent ? ". Silent: level -100 dB" : ""}`}
                aria-label={`Oscillator ${n}, ${WAVE_LABEL[wave]}${silent ? ", silent" : ""}`} onClick={() => setFocus(n)}>
                <span className="n">{n}</span><WaveGlyph wave={wave} />
              </button>
              <Scrub c={lv} label={`Level ${n}`} fmt={fmtLevelBare} valueText={fmtLevel} className="lv"
                testId={`pp-fo-level-${n}`} onPress={() => setFocus(n)}
                title={silent ? `Oscillator ${n} is silent: its level is -100 dB (drag up; double-click for 0 dB)`
                  : `Oscillator ${n} level (drag; double-click for 0 dB)`}
                onChange={(v, gesture) => setParam(lv.index, v, { gesture })}>
                <i className="fill" style={{ width: `${(lv.norm * 100).toFixed(1)}%` }} />
              </Scrub>
            </span>
          );
        })}
        {firstOff !== undefined && (
          <label className={`pp-fo-add${on.length === 0 ? " alone" : ""}`} title={`Add oscillator ${firstOff}`}>
            <span aria-hidden="true">{on.length === 0 ? "+ Oscillator" : "+"}</span>
            <select data-testid="pp-fo-add" aria-label={`Add oscillator ${firstOff}: choose its wave`} value=""
              onChange={(e) => {
                const w = e.target.value;
                if (!w) return;
                // An oscillator a preset parked at -100 dB would come back silent: bring its
                // level up with the wave, in the same undo step (one gesture).
                const lift = addOscLevelDb(plugin, firstOff);
                if (lift === null) setState(`waveShape${firstOff}`, w);
                else {
                  const lv = ctl(plugin, `level${firstOff}`);
                  const gesture = newGestureId();
                  setState(`waveShape${firstOff}`, w, { gesture });
                  setParam(lv.index, normAt(lv.range, lift), { gesture });
                }
                setFocus(firstOff);
              }}>
              <option value="" disabled>{`Add oscillator ${firstOff}`}</option>
              {WAVES.filter((w) => w !== "off").map((w) => <option key={w} value={w}>{WAVE_LABEL[w]}</option>)}
            </select>
          </label>
        )}
      </div>
      {f === undefined
        ? <div className="pp-fo-empty" data-testid="pp-fo-silent">Every oscillator is off: the synth is silent.</div>
        : <OscDetail key={f} n={f} plugin={plugin} setParam={setParam} setState={setState} />}
    </div>
  );
}

function OscDetail({ n, plugin, setParam, setState }: { n: number; plugin: Plugin; setParam: SetParam; setState: SetState }) {
  const wave = waveOf(plugin, n), voices = voicesOf(plugin, n);
  const pitched = wave !== "noise";
  const tune = ctl(plugin, `tune${n}`), fine = ctl(plugin, `fineTune${n}`);
  const pw = ctl(plugin, `pulseWidth${n}`), det = ctl(plugin, `detune${n}`), spr = ctl(plugin, `spread${n}`), pan = ctl(plugin, `pan${n}`);
  const canVoices = hasState(plugin, `voices${n}`);
  return (
    <div className="pp-fo-detail" role="group" aria-label={`Oscillator ${n}`} data-testid="pp-fo-detail">
      <div className="pp-fo-pickers">
        <select className="pp-fo-select" data-testid="pp-fo-wave" aria-label={`Oscillator ${n} wave`} value={wave}
          title="Wave (Off removes the oscillator from the sound)"
          onChange={(e) => setState(`waveShape${n}`, e.target.value)}>
          {WAVES.map((w) => <option key={w} value={w} aria-label={WAVE_LABEL[w]}>{WAVE_MENU[w]}</option>)}
        </select>
        <select className="pp-fo-select" data-testid="pp-fo-voices" aria-label={`Oscillator ${n} unison voices`} value={voices}
          disabled={!canVoices} title="Unison voices: more than one adds Detune and Spread"
          onChange={(e) => setState(`voices${n}`, Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((k) => <option key={k} value={k}>{k === 1 ? "1 voice" : `${k} voices`}</option>)}
        </select>
      </div>
      {/* Inert controls are not shown: noise has no pitch (the engine's noise never reads
          the note, so tune, fine and detune do nothing); pulse width shapes only a square;
          detune and spread need unison voices; pan acts only on a single voice. */}
      {pitched && <>
        <ParamDial c={tune} label="Tune" fmt={fmtSt} setParam={setParam} bipolar quantize={quantizeTo(tune)} testId="pp-fo-tune" />
        <ParamDial c={fine} label="Fine" fmt={fmtCents} setParam={setParam} bipolar testId="pp-fo-fine" />
      </>}
      {wave === "square" && <ParamDial c={pw} label="Width" fmt={(v) => `${Math.round(v * 100)}%`} setParam={setParam} testId="pp-fo-pw"
        title="Pulse width of the square" />}
      {voices > 1 ? <>
        {pitched && <ParamDial c={det} label="Detune" fmt={(v) => fmtCents(v * 100).replace("+", "")} setParam={setParam} testId="pp-fo-detune"
          title="Detune: the unison voices' total spread in pitch" />}
        <ParamDial c={spr} label="Spread" fmt={fmtSignedPct} setParam={setParam} bipolar testId="pp-fo-spread"
          title="Spread: the unison voices' stereo spread" />
      </> : <ParamDial c={pan} label="Pan" fmt={fmtPan} setParam={setParam} bipolar testId="pp-fo-pan" />}
      {!pitched && <span className="pp-fo-note pp-fo-nopitch" data-testid="pp-fo-nopitch">Noise has no pitch</span>}
    </div>
  );
}

// ── AMP ────────────────────────────────────────────────────────────────────────────────

type EnvEdit = Partial<Record<"ampAttack" | "ampDecay" | "ampSustain" | "ampRelease", number>>;
/** The amp envelope plot's three handles. */
type EnvNode = "attack" | "decay" | "release";

function AmpSection({ plugin, setParam }: { plugin: Plugin; setParam: SetParam }) {
  const ids = ["ampAttack", "ampDecay", "ampSustain", "ampRelease"] as const;
  const cs = Object.fromEntries(ids.map((id) => [id, ctl(plugin, id)])) as Record<(typeof ids)[number], Ctl>;
  const vel = ctl(plugin, "ampVelocity");
  const edit = useDragSend<EnvEdit>((e, gesture) => {
    for (const [id, norm] of Object.entries(e) as [keyof EnvEdit, number][]) setParam(cs[id].index, norm, { gesture });
  });
  // What is drawn: the snapshot, with the drag's values over it.
  const shownNorm = (id: keyof EnvEdit) => edit.live?.[id] ?? cs[id].norm;
  const env: Adsr = {
    attack: physAt(cs.ampAttack.range, shownNorm("ampAttack")),
    decay: physAt(cs.ampDecay.range, shownNorm("ampDecay")),
    sustain: clamp(physAt(cs.ampSustain.range, shownNorm("ampSustain")) / 100, 0, 1),
    release: physAt(cs.ampRelease.range, shownNorm("ampRelease")),
  };
  const analog = ampAnalogOf(plugin);
  const g = envGeometry(env, analog);
  const svgRef = useRef<SVGSVGElement>(null);
  // A drag moves by the pointer's travel from where it went down, step by step (so nothing
  // jumps, and Shift can change mid-drag). Sideways it changes the time at a fixed rate,
  // 40 px a decade (Shift: 160): a stage spans 1 ms..60 s in only about 67 px of plot, so
  // the handle following the pointer would be far too coarse; it is drawn where its time
  // puts it. Up and down (the sustain, a linear level) it follows the pointer (Shift: a
  // quarter as far).
  const grab = useRef<{ node: EnvNode; cx: number; py: number; t: number; y: number } | null>(null);
  const toNorm = (id: keyof EnvEdit, phys: number) => normAt(cs[id].range, phys);
  const moveTo = (node: EnvNode, t: number, y: number) => {
    if (node === "attack") edit.update({ ampAttack: toNorm("ampAttack", t) });
    else if (node === "decay") edit.update({ ampDecay: toNorm("ampDecay", t), ampSustain: toNorm("ampSustain", sustainAtY(y) * 100) });
    else edit.update({ ampRelease: toNorm("ampRelease", t) });
  };
  const last = useRef<{ e: EnvEdit; at: number } | null>(null);
  const baseNorm = (id: keyof EnvEdit) => (last.current && Date.now() - last.current.at < BURST_MS ? last.current.e[id] : undefined) ?? cs[id].norm;
  const nudge = (e: EnvEdit) => {
    const prev = last.current && Date.now() - last.current.at < BURST_MS ? last.current.e : {};
    last.current = { e: { ...prev, ...e }, at: Date.now() };
    edit.nudge(e);
  };
  const nodeKey = (node: EnvNode, e: KeyboardEvent<SVGGElement>) => {
    const fine = e.shiftKey ? 0.2 : 1;
    const step = (id: keyof EnvEdit, d: number) => nudge({ [id]: clamp(baseNorm(id) + d, 0, 1) });
    const h = e.key === "ArrowRight" ? 0.01 * fine : e.key === "ArrowLeft" ? -0.01 * fine : 0;
    const v = e.key === "ArrowUp" ? 0.01 * fine : e.key === "ArrowDown" ? -0.01 * fine : 0;
    if (h === 0 && v === 0) return;
    stop(e);
    if (node === "attack") step("ampAttack", h || v);
    else if (node === "release") step("ampRelease", h || v);
    else if (h) step("ampDecay", h);
    else step("ampSustain", v);
  };
  const defaults: Record<EnvNode, EnvEdit> = {
    attack: { ampAttack: cs.ampAttack.defNorm },
    decay: { ampDecay: cs.ampDecay.defNorm, ampSustain: cs.ampSustain.defNorm },
    release: { ampRelease: cs.ampRelease.defNorm },
  };
  const nodeText: Record<EnvNode, string> = {
    attack: `Attack ${fmtTime(env.attack)}`,
    decay: `Decay ${fmtTime(env.decay)}, sustain ${fmtPct100(env.sustain * 100)}`,
    release: `Release ${fmtTime(env.release)}`,
  };
  const present = cs.ampAttack.present && cs.ampDecay.present && cs.ampSustain.present && cs.ampRelease.present;
  return (
    <div className="pp-fo-amp" data-testid="pp-fo-amp">
      <svg ref={svgRef} className={`pp-plot pp-fo-env${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-fo-env"
        viewBox={`0 0 ${ENV_PLOT.w} ${ENV_PLOT.h}`} role="group"
        aria-label={`Amp envelope (${analog ? "analog" : "digital"} curves): ${nodeText.attack}, ${nodeText.decay}, ${nodeText.release}`}>
        <title>{"Each stage's width grows with its time (1 ms to 60 s); inside a stage the shape is the engine's exact curve. Drag a dot sideways: 40 px multiply or divide its time by ten (Shift: four times finer); the decay's dot also sets the sustain up and down. Arrow keys step it; double-click for the default."}</title>
        <line className="zero" x1={g.x0} x2={ENV_PLOT.w - 2} y1={g.yBot} y2={g.yBot} />
        <line className="pp-fo-keyup" x1={g.xOff} x2={g.xOff} y1={g.yTop - 4} y2={g.yBot} />
        <text className="axis" x={g.xOff + 3} y={g.yTop + 2}>key up</text>
        <path className="area" d={fillPath(g.d, g.x0, g.xR, g.yBot)} />
        <path className="curve" data-testid="pp-fo-env-curve" d={g.d} />
        {(["attack", "decay", "release"] as const).map((node) => {
          const p = g.nodes[node];
          return (
            <g key={node} onPointerDownCapture={(e) => {
              if (e.button !== 0 || !svgRef.current) return;
              const pt = clientToSvg(svgRef.current, e.clientX, e.clientY);
              grab.current = { node, cx: e.clientX, py: pt.y, t: node === "attack" ? env.attack : node === "decay" ? env.decay : env.release, y: p.y };
            }}>
              <DragNode x={p.x} y={p.y} r={4.5} active={edit.live !== null && grab.current?.node === node}
                hollow={!present} testId={`pp-fo-env-${node}`}
                ariaLabel={node === "decay" ? "Decay and sustain (left/right: decay, up/down: sustain)" : node === "attack" ? "Attack" : "Release"}
                ariaValueText={nodeText[node]}
                valueNow={node === "attack" ? env.attack : node === "decay" ? env.decay : env.release} valueMin={0} valueMax={60}
                onStart={() => { if (present) edit.begin(); }}
                onMove={(pt, e) => {
                  const gr = grab.current;
                  if (!present || !gr) return;
                  gr.t = envDragTime(gr.t, e.clientX - gr.cx, e.shiftKey);
                  gr.y = clamp(gr.y + (pt.y - gr.py) * (e.shiftKey ? 0.25 : 1), g.yTop, g.yBot);
                  gr.cx = e.clientX;
                  gr.py = pt.y;
                  moveTo(node, gr.t, gr.y);
                }}
                onEnd={() => { grab.current = null; if (present) edit.end(); }}
                onKeyDown={(e) => { if (present) nodeKey(node, e); }}
                onDoubleClick={() => { if (present) nudge(defaults[node]); }} />
            </g>
          );
        })}
      </svg>
      <div className="pp-fo-row">
        <Scrub c={cs.ampAttack} caption="A" label="Attack" fmt={fmtTime} testId="pp-fo-attack"
          onChange={(v, gesture) => setParam(cs.ampAttack.index, v, { gesture })} />
        <Scrub c={cs.ampDecay} caption="D" label="Decay" fmt={fmtTime} testId="pp-fo-decay"
          title="Decay: the time to fall from the peak to silence; it stops at the sustain level"
          onChange={(v, gesture) => setParam(cs.ampDecay.index, v, { gesture })} />
        <Scrub c={cs.ampSustain} caption="S" label="Sustain" fmt={fmtPct100} testId="pp-fo-sustain"
          onChange={(v, gesture) => setParam(cs.ampSustain.index, v, { gesture })} />
        <Scrub c={cs.ampRelease} caption="R" label="Release" fmt={fmtTime} testId="pp-fo-release"
          onChange={(v, gesture) => setParam(cs.ampRelease.index, v, { gesture })} />
        <Scrub c={vel} caption="Vel" label="Velocity sensitivity" fmt={fmtPct100} testId="pp-fo-velocity"
          title="Velocity sensitivity: at 100 % a half-velocity note plays 20 dB quieter; at 0 % every note plays at full level"
          onChange={(v, gesture) => setParam(vel.index, v, { gesture })} />
      </div>
    </div>
  );
}

// ── FILTER ─────────────────────────────────────────────────────────────────────────────

const FPLOT = { w: 273, h: 34 };
const FILTER_DB_FLOOR = -30;
const SLOPES = [12, 24] as const;

function FilterSection({ plugin, sampleRate, setParam, setState }: { plugin: Plugin; sampleRate: number; setParam: SetParam; setState: SetState }) {
  const fs = sampleRate > 0 ? sampleRate : 48000;
  const type = filterTypeOf(plugin), slope = filterSlopeOf(plugin);
  const freq = ctl(plugin, "filterFreq"), res = ctl(plugin, "filterResonance");
  const amt = ctl(plugin, "filterAmount"), key = ctl(plugin, "filterKey"), vel = ctl(plugin, "filterVelocity");
  const drag = useDragSend<number>((norm, gesture) => setParam(freq.index, norm, { gesture }));
  const note = physAt(freq.range, drag.live ?? freq.norm);
  const fc = baseCutoffHz(note, fs);
  const q = resonanceQ(res.phys);
  const top = plotTopHz(fs);
  const x = freqScale(20, top, FPLOT.w);
  const xs = useMemo(() => logFreqs(120, 20, top), [top]);
  const on = type !== "off";
  // The voice's biquads, made once per render (a bypassed synth is silent, not unfiltered:
  // its curve is drawn, muted, rather than flattened).
  const chain = useMemo(() => filterChain(type, slope, fs, fc, q), [type, slope, fs, fc, q]);
  const resp = (f: number) => (chain.length ? chainDb(chain, f, fs) : 0);
  const peak = on ? Math.max(0, ...xs.map(resp)) : 0;
  const yTop = clamp(Math.ceil((peak + 3) / 6) * 6, 6, 42);
  // Off: the flat line sits in the middle, the words under it.
  const y = on ? linScale(FILTER_DB_FLOOR, yTop, FPLOT.h) : linScale(-1, 1, FPLOT.h);
  const curve = curvePath(resp, xs, x, y, 0, FPLOT.h);
  const hx = clamp(x.to(fc), 0, FPLOT.w);
  const hy = clamp(y.to(resp(clamp(fc, 20, top))), 2, FPLOT.h - 2);
  const peakHz = clampCutoffHz(2 ** ((envPeakNote(note, amt.phys) - 69) / 12) * 440, fs);
  const showEnv = on && Math.abs(amt.phys) > 0.005 && Math.abs(x.to(peakHz) - hx) > 2;
  const toNorm = (hz: number) => normAt(freq.range, hzToNote(clampCutoffHz(hz, fs)));
  const grab = useRef<{ x0: number; ux0: number } | null>(null);
  const pressX = useRef<number | null>(null);
  const canType = hasState(plugin, "filterType"), canSlope = hasState(plugin, "filterSlope");
  const envText = showEnv ? `; the filter envelope sweeps it to ${fmtCutoff(peakHz)} at full velocity` : "";
  return (
    <div className={`pp-fo-filter${on ? "" : " off"}`} data-testid="pp-fo-filter" data-type={type}>
      <div className="pp-fo-frow">
        <SettingSeg<FilterType> label="Filter type" className="pp-fo-ftype" options={FILTER_TYPES} value={type} disabled={!canType}
          onPick={(t, gesture) => setState("filterType", t, { gesture })}
          text={(t) => FILTER_SHORT[t]} name={(t) => FILTER_LONG[t]} title={(t) => FILTER_LONG[t]} testId={(t) => `pp-fo-ftype-${t}`} />
        {on && (
          <SettingSeg<12 | 24> label="Filter slope" className="pp-fo-slope" options={SLOPES} value={slope} disabled={!canSlope}
            onPick={(s, gesture) => setState("filterSlope", s, { gesture })}
            text={(s) => String(s)} name={(s) => `${s} dB per octave`}
            title={(s) => (s === 24 ? "24 dB/oct: a second stage at Q 0.707 (the engine clips between the two)" : "12 dB/oct: one stage")}
            testId={(s) => `pp-fo-slope-${s}`} />
        )}
      </div>
      <svg className={`pp-plot pp-fo-fplot${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-fo-fplot"
        viewBox={`0 0 ${FPLOT.w} ${FPLOT.h}`} role="group"
        aria-label={on ? `${FILTER_LONG[type]} ${slope} dB/oct, base cutoff ${fmtCutoff(fc)}${envText}` : "Filter off"}
        onPointerDownCapture={(e) => { pressX.current = clientToSvg(e.currentTarget, e.clientX, e.clientY).x; }}
        onPointerDown={(e) => {
          if (!on || e.button !== 0 || !freq.present) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          grab.current = { x0: pressX.current ?? hx, ux0: pressX.current ?? hx };
          drag.begin();
          drag.update(toNorm(x.from(pressX.current ?? hx)));
        }}
        onPointerMove={(e) => {
          const gr = grab.current;
          if (!gr) return;
          const px = clientToSvg(e.currentTarget, e.clientX, e.clientY).x;
          drag.update(toNorm(x.from(gr.ux0 + (px - gr.x0))));
        }}
        onPointerUp={() => { if (grab.current) { grab.current = null; drag.end(); } }}
        onPointerCancel={() => { if (grab.current) { grab.current = null; drag.end(); } }}
        onLostPointerCapture={() => { if (grab.current) { grab.current = null; drag.end(); } }}>
        {on && <title>{`The BASE cutoff: what middle C gets before the filter envelope and key tracking move it (each note gets its own)${envText}. Drag to move it.`}</title>}
        {[100, 1000, 10000].filter((f) => f < top).map((f) => <line key={f} className="grid" x1={x.to(f)} x2={x.to(f)} y1={0} y2={FPLOT.h} />)}
        <line className="zero" x1={0} x2={FPLOT.w} y1={y.to(0)} y2={y.to(0)} />
        {on && <path className="area" d={fillPath(curve, 0, FPLOT.w, FPLOT.h)} />}
        <path className="curve" data-testid="pp-fo-fcurve" d={curve} />
        {showEnv && (
          // Where the filter envelope takes the cutoff at its peak (full velocity): a dashed
          // line from the handle, at its level, to a small dot.
          <g className="pp-fo-envrange" data-testid="pp-fo-envrange">
            <line x1={hx} x2={clamp(x.to(peakHz), 0, FPLOT.w)} y1={hy} y2={hy} />
            <circle cx={clamp(x.to(peakHz), 1.5, FPLOT.w - 1.5)} cy={hy} r={1.6} />
          </g>
        )}
        {on ? <>
          <line className="pp-fo-fc" x1={hx} x2={hx} y1={0} y2={FPLOT.h} />
          {[100, 1000, 10000].filter((f) => f < top).map((f) => (
            <text key={f} className="axis" x={x.to(f) + 2} y={FPLOT.h - 2}>{f >= 1000 ? `${f / 1000}k` : f}</text>
          ))}
          <DragNode x={hx} y={hy} r={4} hollow={!plugin.enabled} testId="pp-fo-fnode"
            ariaLabel="Base cutoff" ariaValueText={`${fmtCutoff(fc)}${envText}`}
            valueNow={Math.round(fc)} valueMin={8} valueMax={Math.round(Math.min(20000, fs / 2))}
            onStart={() => { grab.current = { x0: pressX.current ?? hx, ux0: hx }; drag.begin(); }}
            onMove={(pt) => { const gr = grab.current; if (gr) drag.update(toNorm(x.from(gr.ux0 + (pt.x - gr.x0)))); }}
            onEnd={() => { grab.current = null; drag.end(); }}
            onKeyDown={(e) => {
              const t = keyStep(e, freq.norm);
              if (t === null) return;
              stop(e);
              drag.nudge(clamp(t, 0, 1));
            }}
            onDoubleClick={() => drag.nudge(freq.defNorm)} />
        </> : (
          <text className="pp-fo-off" data-testid="pp-fo-filter-off" x={FPLOT.w / 2} y={y.to(0) + 12} textAnchor="middle">Filter off: the oscillators pass unfiltered</text>
        )}
      </svg>
      {on && (
        <div className="pp-fo-row">
          <Scrub c={freq} caption="Base" label="Base cutoff" fmt={(n) => fmtCutoff(baseCutoffHz(n, fs))} testId="pp-fo-cutoff"
            title="Base cutoff: middle C before the filter envelope and key tracking move it"
            onChange={(v, gesture) => setParam(freq.index, v, { gesture })} />
          <Scrub c={res} caption="Res" label="Resonance" fmt={fmtPct100} testId="pp-fo-res"
            onChange={(v, gesture) => setParam(res.index, v, { gesture })} />
          <Scrub c={amt} caption="Env" label="Filter envelope amount" fmt={(v) => fmtSignedPct(v * 100)} testId="pp-fo-amount"
            title="How far the filter envelope moves the cutoff (100 % = 137 semitones at its peak)"
            onChange={(v, gesture) => setParam(amt.index, v, { gesture })} />
          <Scrub c={key} caption="Key" label="Key tracking" fmt={fmtPct100} testId="pp-fo-key"
            title="Key tracking: at 100 % the cutoff follows the note played (one semitone per semitone from middle C)"
            onChange={(v, gesture) => setParam(key.index, v, { gesture })} />
          <Scrub c={vel} caption="Vel" label="Filter velocity" fmt={fmtPct100} testId="pp-fo-fvel"
            title="How much a note's velocity scales the filter envelope"
            inert={Math.abs(amt.phys) <= 0.005}
            onChange={(v, gesture) => setParam(vel.index, v, { gesture })} />
        </div>
      )}
    </div>
  );
}

// ── FX ─────────────────────────────────────────────────────────────────────────────────

function FxSection({ plugin, setParam, setState }: { plugin: Plugin; setParam: SetParam; setState: SetState }) {
  const [sel, setSel] = useState<FxKey>(() => FX_ORDER.find((fx) => fxOn(plugin, fx)) ?? "distortion");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segKeyTarget(e.key, FX_ORDER.indexOf(sel), FX_ORDER.length);
    if (to === null) return;
    stop(e);
    setSel(FX_ORDER[to]!);
    refs.current[to]?.focus();
  };
  const on = fxOn(plugin, sel);
  const canToggle = hasState(plugin, FX_STATE[sel]);
  // Tracktion's reverb doubles the dry signal (juce::Reverb's dry scale): switching it on
  // makes the synth louder unless Mix is past 2/3. Said where the switch is.
  const dryDb = sel === "reverb" ? reverbDryDb(ctl(plugin, "reverbMix").phys) : null;
  const dryUp = dryDb !== null && Math.round(dryDb) >= 1 ? Math.round(dryDb) : null;
  const powerTitle = dryUp === null ? undefined
    : `${on ? "The reverb also raises" : "Switching the reverb on also raises"} the dry sound: ${fmtDb(dryDb!)} at this Mix (Tracktion's reverb doubles the dry; no change at Mix 67 %)`;
  return (
    <div className="pp-fo-fx" data-testid="pp-fo-fx">
      {/* The engine's order: distortion, chorus, delay, reverb. A lit dot = in the sound. */}
      <div className="pp-seg pp-fo-fxpick" role="radiogroup" aria-label="Effect" onKeyDown={onKey}>
        {FX_ORDER.map((fx, i) => (
          <button key={fx} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={sel === fx}
            tabIndex={sel === fx ? 0 : -1} className={fxOn(plugin, fx) ? "live" : undefined} data-testid={`pp-fo-fx-${fx}`}
            title={`${FX_NAME[fx]}${fxOn(plugin, fx) ? " (on)" : " (off)"}`} onClick={() => setSel(fx)}>{FX_LABEL[fx]}</button>
        ))}
      </div>
      <div className="pp-fo-detail" role="group" aria-label={FX_NAME[sel]}>
        <span className="pp-fo-powercol">
          <button type="button" className="pp-btn pp-fo-power" role="switch" aria-checked={on} data-testid="pp-fo-fx-power"
            aria-label={`${FX_NAME[sel]} on`} disabled={!canToggle} title={powerTitle}
            onClick={() => setState(FX_STATE[sel], on ? "off" : "on")}>{on ? "On" : "Off"}</button>
          {on && dryUp !== null && (
            <span className="pp-fo-dry" data-testid="pp-fo-reverb-dry" title={powerTitle}>
              <span className="v">{`+${dryUp} dB`}</span><span className="nm">dry</span>
            </span>
          )}
        </span>
        {on ? <FxKnobs fx={sel} plugin={plugin} setParam={setParam} setState={setState} />
          : <span className="pp-fo-note" data-testid="pp-fo-fx-off">{`${FX_NAME[sel]} is off: not in the sound`}</span>}
      </div>
    </div>
  );
}

function FxKnobs({ fx, plugin, setParam, setState }: { fx: FxKey; plugin: Plugin; setParam: SetParam; setState: SetState }) {
  const bpm = useStore((s) => s.snapshot?.session?.tempo);
  const pct = (v: number) => fmtFrac(v);
  if (fx === "distortion") {
    const d = ctl(plugin, "distortion");
    return <ParamDial c={d} label="Drive" fmt={pct} setParam={setParam} testId="pp-fo-drive"
      inert={d.phys <= 0} title={d.phys <= 0 ? "At 0 % the distortion passes the sound through unchanged" : undefined} />;
  }
  const mixId = fx === "chorus" ? "chorusMix" : fx === "delay" ? "delayMix" : "reverbMix";
  const mix = ctl(plugin, mixId);
  const dry = mix.phys <= 0;
  const why = dry ? "No effect while Mix is 0 %" : undefined;
  const mixDial = <ParamDial c={mix} label="Mix" fmt={pct} setParam={setParam} testId="pp-fo-mix"
    title={fx === "reverb" ? `Mix: more reverb, less dry. Tracktion's reverb doubles the dry, so the dry sound is ${fmtDb(reverbDryDb(mix.phys))} here (+6.0 dB at 0 %, no change at 67 %)` : undefined} />;
  if (fx === "chorus") {
    return <>
      <ParamDial c={ctl(plugin, "chorusSpeed")} label="Speed" fmt={(v) => `${v.toFixed(1)} Hz`} setParam={setParam} inert={dry} title={why} />
      <ParamDial c={ctl(plugin, "chorusDepth")} label="Depth" fmt={(v) => `${v.toFixed(1)} ms`} setParam={setParam} inert={dry} title={why} />
      <ParamDial c={ctl(plugin, "chorusWidth")} label="Width" fmt={pct} setParam={setParam} inert={dry} title={why} />
      {mixDial}
    </>;
  }
  if (fx === "delay") {
    const beats = delayBeatsOf(plugin);
    const label = delayNote(beats);
    const sec = bpm ? delaySeconds(beats, bpm) : NaN;
    const wraps = Number.isFinite(sec) && sec > DELAY_MAX_SEC;
    return <>
      <span className={`pp-fo-time${wraps ? " warn" : ""}`}
        title={wraps ? `At ${Math.round(bpm!)} BPM this is ${sec.toFixed(2)} s: longer than the 5.1 s delay line, so it wraps` : "Delay time, in note values at the song's tempo"}>
        <select className="pp-fo-select" data-testid="pp-fo-delay-time" aria-label="Delay time" value={label ?? ""}
          disabled={!hasState(plugin, "delayBeats")}
          onChange={(e) => { const n = DELAY_NOTES.find((d) => d.label === e.target.value); if (n) setState("delayBeats", n.beats); }}>
          {!label && <option value="" disabled>{`${beats.toFixed(3)} beats`}</option>}
          {DELAY_NOTES.map((d) => <option key={d.label} value={d.label}>{d.label}</option>)}
        </select>
        <span className="v">{Number.isFinite(sec) ? (sec < 1 ? `${Math.round(sec * 1000)} ms` : `${sec.toFixed(2)} s`) : `${beats} beats`}</span>
        <span className="nm">Time</span>
      </span>
      <ParamDial c={ctl(plugin, "delayFeedback")} label="Feedback" fmt={fmtDbShort} setParam={setParam} inert={dry} title={why} />
      <ParamDial c={ctl(plugin, "delayCrossfeed")} label="Cross" fmt={fmtDbShort} setParam={setParam} inert={dry}
        title={why ?? "Crossfeed: how much of each side feeds the other (ping-pong)"} />
      {mixDial}
    </>;
  }
  return <>
    <ParamDial c={ctl(plugin, "reverbSize")} label="Size" fmt={pct} setParam={setParam} inert={dry} title={why} />
    <ParamDial c={ctl(plugin, "reverbDamping")} label="Damping" fmt={pct} setParam={setParam} inert={dry} title={why} />
    <ParamDial c={ctl(plugin, "reverbWidth")} label="Width" fmt={pct} setParam={setParam} inert={dry} title={why} />
    {mixDial}
  </>;
}

// ── MOD (only when the session carries routes; read-only) ──────────────────────────────

function ModSection({ plugin }: { plugin: Plugin }) {
  const routes = plugin.modRoutes ?? [];
  return (
    <div className="pp-fo-mod" data-testid="pp-fo-mod">
      <ul className="pp-fo-routes" aria-label="Modulation routes">
        {routes.map((r, i) => (
          <li key={`${r.paramIndex}-${r.source}-${i}`}>
            <span className="src">{modSourceLabel(r.source)}</span>
            <span className="arrow" aria-hidden="true">→</span>
            <span className="dst">{paramLabel(r.id, plugin.params.find((p) => p.index === r.paramIndex)?.name)}</span>
            <span className="depth">{fmtModDepth(r.depth)}</span>
          </li>
        ))}
      </ul>
      <span className="pp-fo-note">From the session file (read-only in Mosh)</span>
    </div>
  );
}

// ── live keys ──────────────────────────────────────────────────────────────────────────

const STRIP_W = 273, STRIP_H = 8;

/** The keys held at the synth (from the MIDI it receives: keys, not voices) and a short
 *  flash on each key struck, once per frame. Dim when no frame is arriving. */
function KeyStrip({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const m = usePluginMeter<FourOscMeter>(trackId, plugin.index, { type: "4osc", itemId: plugin.itemId });
  const flashes = useMeterEvents(m, "struck");
  const held = useMemo(() => new Set(Array.isArray(m?.held) ? m!.held : []), [m]);
  const [lo, hi] = stripRange([...held]);
  const keys = useMemo(() => keyStrip(lo, hi, STRIP_W), [lo, hi]);
  const heldNames = [...held].sort((a, b) => a - b).map(noteName);
  return (
    <svg className={`pp-fo-keys${m ? "" : " idle"}`} data-testid="pp-fo-keys" data-live={m ? "" : undefined}
      viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} preserveAspectRatio="none" role="img"
      aria-label={heldNames.length ? `Keys held: ${heldNames.join(", ")}` : m ? "No keys held" : "No notes arriving"}>
      {keys.filter((k) => !k.black).map((k) => (
        <rect key={k.note} className={`w${held.has(k.note) ? " held" : ""}${flashes.has(k.note) ? " struck" : ""}`}
          x={k.x} y={0} width={Math.max(0.5, k.w - 0.6)} height={STRIP_H} data-note={k.note} />
      ))}
      {keys.filter((k) => k.black).map((k) => (
        <rect key={k.note} className={`b${held.has(k.note) ? " held" : ""}${flashes.has(k.note) ? " struck" : ""}`}
          x={k.x} y={0} width={k.w} height={STRIP_H * 0.6} data-note={k.note} />
      ))}
    </svg>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────────────────

/** Tracktion's 4OSC: one section at a time (oscillators, amp envelope, filter, effects, and
 *  the read-only modulation routes when a session has any), the preset menu and master
 *  level on top, the keys being played underneath. */
function FourOscPanel(props: PanelProps) {
  const { plugin, trackId, sampleRate, setParam, setState } = props;
  const viewKey = plugin.itemId ?? `${trackId}:${plugin.index}`;
  const [section, setSectionState] = useState<Section>(() => loadSection(viewKey) ?? "osc");
  const presets = (
    <PresetPicker plugin={plugin} trackId={trackId}
      onLoaded={(pr) => usePresetMemory.getState().remember(trackId, plugin.index, pr.name)} />
  );
  if (!hasFullContract(plugin)) {
    // An older engine: it sends 16 parameters and no settings, so the panel cannot read the
    // amp, filter or waves. Keep the plain rows rather than draw defaults as if they were real.
    return (
      <div className="pp-fourosc legacy" data-testid="pp-fourosc" data-legacy="" onKeyDown={keepNavKeys}>
        {presets}
        <GenericParams plugin={plugin} setParam={setParam} />
        <div className="pp-fo-note" data-testid="pp-fo-legacy">The full 4OSC panel needs the updated Mosh engine.</div>
      </div>
    );
  }
  const hasMod = (plugin.modRoutes?.length ?? 0) > 0;
  const sections: Section[] = hasMod ? ["osc", "amp", "filter", "fx", "mod"] : ["osc", "amp", "filter", "fx"];
  const shown: Section = sections.includes(section) ? section : "osc";
  const setSection = (s: Section) => { setSectionState(s); saveSection(viewKey, s); };
  const lit: Partial<Record<Section, boolean>> = {
    filter: filterTypeOf(plugin) !== "off",
    fx: FX_ORDER.some((fx) => fxOn(plugin, fx)),
    mod: hasMod,
  };
  return (
    <div className="pp-fourosc" data-testid="pp-fourosc" data-section={shown} onKeyDown={keepNavKeys}>
      <div className="pp-fo-top">
        <SectionSeg sections={sections} value={shown} lit={lit} onChange={setSection} />
        {presets}
        <MasterLevel plugin={plugin} trackId={trackId} setParam={setParam} />
      </div>
      <div className="pp-fo-body">
        {shown === "osc" && <OscSection plugin={plugin} setParam={setParam} setState={setState} />}
        {shown === "amp" && <AmpSection plugin={plugin} setParam={setParam} />}
        {shown === "filter" && <FilterSection plugin={plugin} sampleRate={sampleRate} setParam={setParam} setState={setState} />}
        {shown === "fx" && <FxSection plugin={plugin} setParam={setParam} setState={setState} />}
        {shown === "mod" && <ModSection plugin={plugin} />}
      </div>
      <KeyStrip plugin={plugin} trackId={trackId} />
    </div>
  );
}

// ── minimized ──────────────────────────────────────────────────────────────────────────

const MINI_BOX: EnvBox = { w: 44, h: 11, padL: 0.75, padTop: 1, padBottom: 0.75, segMin: 1.5, segMax: 12, holdMin: 6 };

/** The amp envelope's silhouette with the live output under it (a line that grows with
 *  the level; absent when no frame arrives). */
function FourOscMini({ plugin, trackId }: PanelProps) {
  const m = usePluginMeter<FourOscMeter>(trackId, plugin.index, { type: "4osc", itemId: plugin.itemId });
  const full = hasFullContract(plugin);
  const g = full ? envGeometry(ampAdsr(plugin), ampAnalogOf(plugin), MINI_BOX, 10) : null;
  const fill = m && Number.isFinite(m.outDb) ? meterFill(m.outDb, 0, OUT_FLOOR_DB) : 0;
  return (
    <svg className={`pp-fo-mini${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-fo-mini" data-live={m ? "" : undefined}
      width={44} height={14} viewBox="0 0 44 14" aria-hidden="true">
      {g && <path className="env" d={`${g.d} Z`} />}
      <line className="trk" x1={0} x2={44} y1={13} y2={13} />
      {fill > 0 && <line className="out" x1={0} x2={(44 * fill).toFixed(2)} y1={13} y2={13} />}
    </svg>
  );
}

export const fourOscPanelDef: PanelDef = {
  Panel: FourOscPanel,
  summary: (plugin) => fourOscSummary(plugin, useStore.getState().snapshot?.session?.sampleRate || 48000),
  Mini: FourOscMini,
  ownsPresets: true,
};
