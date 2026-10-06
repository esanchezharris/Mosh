import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useStore } from "../../store";
import { Dial } from "./Dial";
import { DragNode } from "./DragNode";
import { clamp, fmtDb, normOf, param, physOf } from "./params";
import {
  DEFAULTS, FEEDBACK, FLOOR_DB, MIX, NOTES, TIME, clampMs, delayModel, delaySummary, fmtFeedback, fmtMix, fmtTail,
  fmtTime, matchingNote, noteMs, tailText, timeFromDrag, timeKey, viewMs, type DelayModel,
} from "./delay";
import type { PanelDef, PanelProps } from "./types";
import { SETTLE_MS, useDragSend } from "./useDragSend";

const STRIP = { w: 286, h: 48, padX: 4, padT: 3, padB: 3 } as const;
/** A time drag must move this far (px, or strip units ≈ px) before it counts: a click with a
 *  pixel of jitter must not send a time change (each one re-indexes the buffer: a glitch). */
const DEAD_ZONE = 3;
/** Time keys preview at once and send ONE set_plugin_state when the burst (or a held key's
 *  auto-repeat) has been quiet this long, or on blur. */
const KEY_COMMIT_MS = 400;

function stripAxes(view: number) {
  const inner = STRIP.w - 2 * STRIP.padX, tall = STRIP.h - STRIP.padT - STRIP.padB;
  return {
    tx: (ms: number) => STRIP.padX + (clamp(ms, 0, view) / view) * inner,
    xt: (x: number) => ((x - STRIP.padX) / inner) * view,
    dy: (dB: number) => STRIP.padT + (clamp(dB, FLOOR_DB, 0) / FLOOR_DB) * tall,
    yd: (y: number) => ((y - STRIP.padT) / tall) * FLOOR_DB,
    top: STRIP.padT, bottom: STRIP.h - STRIP.padB, right: STRIP.w - STRIP.padX,
  };
}

/** The echoes' decay line: from the first echo, falling `feedbackDb` per period, to the
 *  floor or the strip's right edge. */
function envelope(m: DelayModel, view: number): { x1: number; y1: number; x2: number; y2: number } | null {
  if (m.oneRepeat || m.taps.length === 0) return null;
  const a = stripAxes(view);
  const first = m.taps[0];
  const tEnd = m.infinite ? view : first.ms + m.periodMs * ((first.db - FLOOR_DB) / -m.feedbackDb);
  const t2 = Math.min(view, tEnd);
  const db2 = m.infinite ? first.db : first.db + ((t2 - first.ms) / m.periodMs) * m.feedbackDb;
  return { x1: a.tx(first.ms), y1: a.dy(first.db), x2: a.tx(t2), y2: a.dy(db2) };
}

/** The impulse response: a dry stem at 0, then each echo at k × the time, at its level. */
function EchoStrip({ m, view, enabled, onTimeStart, onTimeMove, onTimeEnd, timeKeys, onFbStart, onFbMove, onFbEnd, fbKeys }: {
  m: DelayModel; view: number; enabled: boolean;
  onTimeStart: () => void; onTimeMove: (ms: number) => void; onTimeEnd: () => void; timeKeys: (e: KeyboardEvent) => void;
  onFbStart: () => void; onFbMove: (dB: number) => void; onFbEnd: () => void; fbKeys: (e: KeyboardEvent) => void;
}) {
  const a = stripAxes(view);
  const env = envelope(m, view);
  const hasWet = m.taps.length > 0;
  const first = m.taps[0];
  // Both handles move by the pointer's DELTA from where the drag started, never to its
  // absolute position: a handle can be drawn clamped at the floor (a second echo below
  // -60 dB) or grabbed off-centre, and an absolute map would make the value jump.
  const timeGrab = useRef<{ x0: number | null; ms0: number; active: boolean } | null>(null);
  const fbGrab = useRef<{ y0: number | null; db0: number } | null>(null);
  // The second-repeat handle sits where echo 2 is (or would be, with the loop off).
  const fbY = hasWet ? a.dy(first.db + (m.oneRepeat ? FEEDBACK.min : m.feedbackDb)) : a.bottom;
  const ticks: number[] = [];
  const tickStep = view <= 600 ? 100 : view <= 2000 ? 250 : 500;
  for (let t = tickStep; t < view - 1e-6; t += tickStep) ticks.push(t);
  return (
    <svg className={`pp-plot pp-delay-strip${enabled ? "" : " bypassed"}${m.infinite ? " inf" : ""}`}
      viewBox={`0 0 ${STRIP.w} ${STRIP.h}`} data-testid="pp-delay-strip" role="group"
      aria-label={`Echoes every ${fmtTime(m.lengthMs)}: ${tailText(m)}`}>
      {ticks.map((t) => <line key={t} className="grid" x1={a.tx(t)} x2={a.tx(t)} y1={a.top} y2={a.bottom} />)}
      {[-20, -40].map((dB) => <line key={dB} className="grid" x1={STRIP.padX} x2={a.right} y1={a.dy(dB)} y2={a.dy(dB)} />)}
      <line className="zero" x1={STRIP.padX} x2={a.right} y1={a.bottom} y2={a.bottom} />
      {Number.isFinite(m.dryDb) && (
        <line className="pp-delay-dry" x1={a.tx(0)} x2={a.tx(0)} y1={a.bottom} y2={a.dy(m.dryDb)} data-testid="pp-delay-dry" />
      )}
      {env && <line className="pp-delay-env" {...env} />}
      {m.taps.map((t) => t.ms <= view && (
        <line key={t.k} className="pp-delay-tap" data-testid="pp-delay-tap" x1={a.tx(t.ms)} x2={a.tx(t.ms)} y1={a.bottom} y2={a.dy(t.db)} />
      ))}
      <text className={`pp-delay-read${m.infinite ? " warn" : ""}`} x={a.right - 2} y={a.top + 8} textAnchor="end"
        data-testid="pp-delay-tail">{tailText(m)}</text>
      {hasWet && (
        <DragNode x={a.tx(2 * m.periodMs)} y={fbY} r={3.5} hollow={m.oneRepeat} testId="pp-delay-fb-node"
          ariaLabel="Feedback (second echo level)" ariaValueText={`${fmtFeedback(m)}, ${tailText(m)}`}
          valueNow={m.feedbackDb} valueMin={-30} valueMax={0}
          onStart={() => { fbGrab.current = { y0: null, db0: m.feedbackDb }; onFbStart(); }}
          onEnd={() => { fbGrab.current = null; onFbEnd(); }} onKeyDown={fbKeys}
          onMove={(pt) => {
            const g = fbGrab.current;
            if (!g) return;
            if (g.y0 === null) { g.y0 = pt.y; return; }
            onFbMove(g.db0 + (a.yd(pt.y) - a.yd(g.y0)));
          }} />
      )}
      <DragNode x={a.tx(m.periodMs)} y={hasWet ? a.dy(first.db) : a.bottom} r={4} testId="pp-delay-time-node"
        ariaLabel="Delay time (first echo)" ariaValueText={fmtTime(m.lengthMs)}
        valueNow={m.lengthMs} valueMin={1} valueMax={Math.max(2000, m.lengthMs)}
        onStart={() => { timeGrab.current = { x0: null, ms0: m.lengthMs, active: false }; onTimeStart(); }}
        onEnd={() => { timeGrab.current = null; onTimeEnd(); }} onKeyDown={timeKeys}
        onMove={(pt) => {
          const g = timeGrab.current;
          if (!g) return;
          if (g.x0 === null) { g.x0 = pt.x; return; }
          const dx = pt.x - g.x0;
          if (!g.active) {
            if (Math.abs(dx) < DEAD_ZONE) return;
            g.active = true;
            g.x0 += Math.sign(dx) * DEAD_ZONE;   // continue smoothly from the threshold
          }
          onTimeMove(g.ms0 + (a.xt(pt.x) - a.xt(g.x0)));
        }} />
    </svg>
  );
}

/** The delay time as a read-out you drag sideways (60 px doubles it, Shift for fine). It
 *  previews while dragging and sends ONE set_plugin_state on release: a time change in the
 *  engine re-reads its buffer and glitches, so it must not be sent on every move. */
function TimeScrub({ ms, onStart, onPreview, onCommit, keys, onBlur }: {
  ms: number; onStart: () => void; onPreview: (ms: number) => void; onCommit: (ms: number) => void;
  keys: (e: KeyboardEvent) => void; onBlur: () => void;
}) {
  const start = useRef<{ x: number; ms: number; last: number; active: boolean } | null>(null);
  const finish = () => {
    const s = start.current;
    if (!s) return;
    start.current = null;
    // Always settle a drag that moved, even back to where it began: onCommit skips the send
    // when the value is unchanged and lets the preview go, so the engine's value shows again.
    if (s.active) onCommit(s.last);
  };
  return (
    <div className="pp-delay-time" role="slider" tabIndex={0} data-testid="pp-delay-time"
      aria-label="Delay time" aria-valuemin={TIME.min} aria-valuemax={Math.max(TIME.max, ms)} aria-valuenow={ms} aria-valuetext={fmtTime(ms)}
      title="Drag sideways (Shift: fine). Arrows ±1 ms, PageUp/PageDown double or halve. Applied on release."
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onStart();
        start.current = { x: e.clientX, ms, last: ms, active: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        if (!s.active) {
          const dx0 = e.clientX - s.x;
          if (Math.abs(dx0) < DEAD_ZONE) return;
          s.active = true;
          s.x += Math.sign(dx0) * DEAD_ZONE;   // continue smoothly from the threshold
        }
        s.last = timeFromDrag(s.ms, e.clientX - s.x, e.shiftKey);
        onPreview(s.last);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={keys} onBlur={onBlur}
      onDoubleClick={() => onCommit(DEFAULTS.lengthMs)}>
      <span className="v">{ms}<small> ms</small></span>
      <span className="nm">Time</span>
    </div>
  );
}

/** Tracktion Delay: the echo strip, Time (applied on release), Feedback and Mix. */
function DelayPanel({ plugin, sampleRate, setParam, setState }: PanelProps) {
  const bpm = useStore((s) => s.snapshot?.session?.tempo);
  const fbDrag = useDragSend<number>((v, gesture) => setParam(0, v, { gesture }));
  const [preview, setPreview] = useState<number | null>(null);
  // The time the first-echo handle has been dragged to (readable at pointer-up even before
  // React re-renders); null when the handle has not moved.
  const nodeTime = useRef<number | null>(null);
  const [heldView, setHeldView] = useState<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A key burst's pending time: previewed now, sent once when the keys go quiet.
  const keyPending = useRef<{ ms: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const fbParam = param(plugin, 0) ?? { index: 0, name: "Feedback", value: 0.8 };
  const m = delayModel(plugin, sampleRate, {
    ...(fbDrag.live !== null ? { feedbackDb: physOf({ ...fbParam, value: fbDrag.live }, FEEDBACK) } : {}),
    ...(preview !== null ? { lengthMs: preview } : {}),
  });
  // What the engine runs now, unclamped (a loaded edit may hold more than 2000 ms).
  const committed = delayModel(plugin, sampleRate).lengthMs;
  const view = heldView ?? viewMs(m);
  const latest = useRef({ committed, setState });
  latest.current = { committed, setState };
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
    // Unmounted (e.g. minimized) mid key burst: still send the time the keys reached.
    const k = keyPending.current;
    if (k) {
      clearTimeout(k.timer);
      keyPending.current = null;
      if (k.ms !== latest.current.committed) latest.current.setState("lengthMs", k.ms);
    }
  }, []);

  const showPreview = (ms: number) => {
    if (settle.current) { clearTimeout(settle.current); settle.current = null; }
    setPreview(clampMs(ms));
  };
  /** Send the time once (unless it is what the engine already runs); keep showing it until
   *  the engine's patch arrives, then let the preview go. */
  const commitTime = (ms: number) => {
    const v = clampMs(ms);
    // An explicit commit (release, note menu, double-click) supersedes a pending key burst.
    if (keyPending.current) { clearTimeout(keyPending.current.timer); keyPending.current = null; }
    if (v !== latest.current.committed) latest.current.setState("lengthMs", v);
    setPreview(v);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => { settle.current = null; setPreview(null); }, SETTLE_MS);
  };
  const commitRef = useRef(commitTime);
  commitRef.current = commitTime;
  /** Send a pending key burst now (blur, or a drag starting). */
  const flushKeys = () => {
    const k = keyPending.current;
    if (!k) return;
    clearTimeout(k.timer);
    keyPending.current = null;
    commitRef.current(k.ms);
  };
  /** Keys preview each step at once (from the previewed value, so a burst accumulates) and
   *  send ONE set_plugin_state when the burst ends: never one per key or auto-repeat. */
  const onTimeKeys = (e: KeyboardEvent) => {
    const next = timeKey(m.lengthMs, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    if (next === m.lengthMs) return;
    showPreview(next);
    if (keyPending.current) clearTimeout(keyPending.current.timer);
    keyPending.current = {
      ms: next,
      timer: setTimeout(() => { keyPending.current = null; commitRef.current(next); }, KEY_COMMIT_MS),
    };
  };
  const onFbKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.5;
    const map: Record<string, number> = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 3, PageDown: -3 };
    let dB: number | null = null;
    if (e.key in map) dB = m.feedbackDb + map[e.key];
    else if (e.key === "Home") dB = FEEDBACK.min;
    else if (e.key === "End") dB = FEEDBACK.max;
    if (dB === null) return;
    e.preventDefault();
    fbDrag.nudge(normOf(fbParam, clamp(dB, FEEDBACK.min, FEEDBACK.max), FEEDBACK));
  };
  const note = bpm ? matchingNote(m.lengthMs, bpm) : null;
  const mixNorm = normOf(param(plugin, 1), m.mix, MIX);

  return (
    <div className="pp-delay" data-testid="pp-delay">
      <EchoStrip m={m} view={view} enabled={plugin.enabled}
        onTimeStart={() => { flushKeys(); setHeldView(view); nodeTime.current = null; }}
        onTimeMove={(ms) => { nodeTime.current = clampMs(ms); showPreview(ms); }}
        onTimeEnd={() => { setHeldView(null); if (nodeTime.current !== null) commitTime(nodeTime.current); nodeTime.current = null; }}
        timeKeys={onTimeKeys}
        onFbStart={() => { setHeldView(view); fbDrag.begin(); }}
        onFbMove={(dB) => fbDrag.update(normOf(fbParam, clamp(dB, FEEDBACK.min, FEEDBACK.max), FEEDBACK))}
        onFbEnd={() => { fbDrag.end(); setHeldView(null); }}
        fbKeys={onFbKeys} />
      <div className="pp-delay-ctl">
        <TimeScrub ms={m.lengthMs} onStart={flushKeys} onPreview={showPreview} onCommit={commitTime} keys={onTimeKeys} onBlur={flushKeys} />
        {bpm ? (
          <select className="pp-delay-note" data-testid="pp-delay-note" value={note ?? ""}
            aria-label={`Set the time from a note value at ${Math.round(bpm)} BPM`}
            title="Sets a fixed time from the tempo now. It does not follow later tempo changes."
            onChange={(e) => {
              const n = NOTES.find((x) => x.label === e.target.value);
              if (n) commitTime(noteMs(n.beats, bpm));
            }}>
            <option value="" disabled>note</option>
            {NOTES.map((n) => {
              const ms = noteMs(n.beats, bpm);
              return <option key={n.label} value={n.label} disabled={ms < TIME.min || ms > TIME.max}>{`${n.label} · ${ms} ms`}</option>;
            })}
          </select>
        ) : null}
        <span className={m.infinite ? "pp-delay-warn" : undefined}
          title={m.infinite ? "0 dB: the echoes never decay, and nothing in the loop limits them" : m.oneRepeat ? "At the bottom the loop is off: one echo" : undefined}>
          <Dial label="Feedback" size={30} norm={fbDrag.live ?? fbParam.value} defaultNorm={(DEFAULTS.feedbackDb - FEEDBACK.min) / (FEEDBACK.max - FEEDBACK.min)}
            testId="pp-delay-feedback" display={fmtFeedback(m)}
            valueText={`${fmtFeedback(m)}${m.tailS !== null ? `, echoes fall 60 dB in ${fmtTail(m.tailS)}` : ""}`}
            onChange={(v, gesture) => setParam(0, v, { gesture })} />
        </span>
        <Dial label="Mix" size={30} norm={mixNorm} defaultNorm={DEFAULTS.mix} testId="pp-delay-mix"
          display={fmtMix(m.mix)} valueText={`${fmtMix(m.mix)}: echoes ${fmtDb(m.wetDb)}, dry ${fmtDb(m.dryDb)}`}
          onChange={(v, gesture) => setParam(1, v, { gesture })} />
      </div>
    </div>
  );
}

const MINI = { w: 32, h: 12 };

/** Minimized: the echo pattern as tiny stems (dry stem muted). */
function DelayMini({ plugin, sampleRate }: PanelProps) {
  const m = delayModel(plugin, sampleRate);
  const view = viewMs(m);
  const x = (ms: number) => 1 + (ms / view) * (MINI.w - 2);
  const y = (dB: number) => MINI.h - ((clamp(dB, FLOOR_DB, 0) - FLOOR_DB) / -FLOOR_DB) * MINI.h;
  return (
    <svg className={`pp-delay pp-delay-mini${plugin.enabled ? "" : " bypassed"}${m.infinite ? " inf" : ""}`}
      width={MINI.w} height={MINI.h} viewBox={`0 0 ${MINI.w} ${MINI.h}`} aria-hidden="true" data-testid="pp-delay-mini">
      {Number.isFinite(m.dryDb) && <line className="dry" x1={1} x2={1} y1={MINI.h} y2={y(m.dryDb)} />}
      {m.taps.filter((t) => t.ms <= view).map((t) => <line key={t.k} x1={x(t.ms)} x2={x(t.ms)} y1={MINI.h} y2={y(t.db)} />)}
    </svg>
  );
}

export const delayPanelDef: PanelDef = {
  Panel: DelayPanel,
  summary: (plugin) => delaySummary(plugin, useStore.getState().snapshot?.session?.sampleRate || 48000),
  Mini: DelayMini,
};
