// Moshi Redesign Lab — the runtime bake-off for the post-raymarcher Moshi, dev-only at
// `?view=moshi-lab`. Three candidates render the SAME shared brain poses, driven by ONE
// control rack, so the comparison is apples-to-apples:
//
//   A · SVG + TS springs   (zero deps — he IS the logo, animated)
//   B · Rive workalike     (A's pixels through a Rive-style state machine — Rive's value
//                           is the authoring model, not the pixels; drop a real .riv below)
//   C · trimmed 2D shader  (the raymarch look lineage — flat / porcelain / ps2 — without
//                           the 1351-line raymarcher)
//
// The voice is the product's own voice.js, unchanged — hear how each body pairs with it.
// No store, no bridge, no engine (same doctrine as the character lab).

import { useEffect, useRef, useState } from "react";
import "../../vendor/voice.js";
import { DEFAULT_KEY } from "../../musicalKey";
import { MoshiSvg } from "./MoshiSvg";
import { MoshiGL2D, GL_MODES, type MoshiGLMode } from "./MoshiGL2D";
import { MoshiStateMachine, SM_BOOLS, type SMBool } from "./moshiStateMachine";
import {
  MoshiBrain, MOSHI_STATES,
  type MoshiBody, type MoshiDriveKey, type MoshiStateName,
} from "./moshiModel";
import "./moshiLab.css";

type VoiceApi = {
  unlock: () => void;
  play: (intent: string, o?: object) => unknown;
  startLoop: (intent: string, o?: object) => VoiceApi;
  stopLoop: () => VoiceApi;
  setEnabled: (b: boolean) => VoiceApi;
  setKey: (name: string | number, mode?: string) => VoiceApi;
  destroy: () => VoiceApi;
};

const DRIVES: readonly { key: MoshiDriveKey; label: string; hint: string }[] = [
  { key: "energy", label: "ENERGY", hint: "how hard the work is going — wobble + bounce" },
  { key: "mood", label: "MOOD", hint: "resting grin + liveliness" },
  { key: "heat", label: "HEAT", hint: "REC excitement — the lime aura" },
];
const VOICE_INTENTS = ["GREET", "ACK_WORKING", "DONE", "UHOH"] as const;

export function MoshiLab() {
  // ── bodies: A stage+orb, B stage(SM-owned brain)+orb, C stage+orb ──────────
  const aStage = useRef<MoshiBody>(null);
  const aOrb = useRef<MoshiBody>(null);
  const bBrain = useRef<MoshiBrain | null>(null);
  if (!bBrain.current) bBrain.current = new MoshiBrain();
  const sm = useRef<MoshiStateMachine | null>(null);
  if (!sm.current) sm.current = new MoshiStateMachine(bBrain.current);
  const bStage = useRef<MoshiBody>(null);
  const bOrb = useRef<MoshiBody>(null);
  const cStage = useRef<MoshiBody>(null);
  const cOrb = useRef<MoshiBody>(null);

  const bodies = (): (MoshiBody | null)[] =>
    [aStage.current, aOrb.current, bStage.current, bOrb.current, cStage.current, cOrb.current];

  // ── rack state ──
  const [drives, setDrives] = useState<Record<MoshiDriveKey, number>>({ energy: 0.35, mood: 0.6, heat: 0.12 });
  const [state, setState] = useState<MoshiStateName>("IDLE");
  const [follow, setFollow] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [working, setWorking] = useState(false);
  const [glMode, setGlMode] = useState<MoshiGLMode>("porcelain");
  const [cpu, setCpu] = useState({ a: 0, b: 0, c: 0 });
  const [smBools, setSmBools] = useState<Record<SMBool, boolean>>({ playing: false, recording: false, rendering: false, tired: false });
  const [smLog, setSmLog] = useState<string[]>([]);
  const [rivNote, setRivNote] = useState<string>("no .riv loaded — author one in the Rive editor and drop it here");
  const voiceRef = useRef<VoiceApi | null>(null);
  const speakTimer = useRef(0);

  // ── voice: created lazily inside the first user gesture (autoplay policy) ──
  const ensureVoice = (): VoiceApi | null => {
    if (voiceRef.current) return voiceRef.current;
    try {
      const Ctor = (window as unknown as { MoshiVoice?: (o?: object) => VoiceApi }).MoshiVoice;
      if (typeof Ctor !== "function") return null;
      const v = Ctor({ master: 0.55, enabled: true });
      v.unlock();
      v.setKey(DEFAULT_KEY.tonic, DEFAULT_KEY.mode);
      voiceRef.current = v;
      return v;
    } catch { return null; }
  };
  useEffect(() => () => {
    window.clearTimeout(speakTimer.current);
    try { voiceRef.current?.destroy(); } catch { /* noop */ }
  }, []);

  const speakPulse = (ms: number) => {
    for (const b of bodies()) b?.speak(true);
    window.clearTimeout(speakTimer.current);
    speakTimer.current = window.setTimeout(() => { for (const b of bodies()) b?.speak(false); }, ms);
  };

  // ── rack actions ──
  const onDrive = (key: MoshiDriveKey, v: number) => {
    setDrives((d) => ({ ...d, [key]: v }));
    sm.current?.setDrive(key, v);
    for (const b of bodies()) b?.set(key, v);
  };
  const onState = (s: MoshiStateName) => {
    setState(s);
    const accepted = sm.current?.request(s) ?? false; // candidate B goes through the guard rails
    for (const b of [aStage.current, aOrb.current, cStage.current, cOrb.current]) b?.setState(s);
    if (accepted) bOrb.current?.setState(s); // B's twin mirrors the SM's verdict, not the request
  };
  const onPoke = () => {
    sm.current?.fire("poke");
    for (const b of [aStage.current, aOrb.current, bOrb.current, cStage.current, cOrb.current]) b?.poke();
  };
  const onCelebrate = () => {
    sm.current?.fire("celebrate");
    for (const b of [aStage.current, aOrb.current, bOrb.current, cStage.current, cOrb.current]) b?.celebrate();
  };
  const onSmBool = (name: SMBool) => {
    const v = !smBools[name];
    setSmBools((m) => ({ ...m, [name]: v }));
    sm.current?.setBool(name, v);
    if (sm.current) bOrb.current?.setState(sm.current.current); // twin mirrors the resolved state
  };
  const onVoice = (intent: (typeof VOICE_INTENTS)[number]) => {
    const v = ensureVoice();
    if (intent === "ACK_WORKING") {
      const next = !working;
      setWorking(next);
      try { if (next) v?.startLoop(intent, {}); else v?.stopLoop(); } catch { /* noop */ }
      for (const b of bodies()) b?.speak(next);
      return;
    }
    try { v?.play(intent, {}); } catch { /* noop */ }
    speakPulse(intent === "GREET" ? 900 : 700);
  };

  // ── follow-cursor: every body gazes at the pointer ──
  useEffect(() => {
    if (!follow) return;
    const onMove = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth - 0.5) * 2;
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      sm.current?.lookAt(nx, ny);
      for (const b of bodies()) b?.lookAt(nx, ny);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [follow]);

  // ── voice enable toggle ──
  useEffect(() => { try { voiceRef.current?.setEnabled(voiceOn); } catch { /* noop */ } }, [voiceOn]);

  // ── readouts: per-candidate CPU cost + the SM transition log, polled 2×/s ──
  useEffect(() => {
    const t = window.setInterval(() => {
      setCpu({
        a: aStage.current?.cpuMs() ?? 0,
        b: bStage.current?.cpuMs() ?? 0,
        c: cStage.current?.cpuMs() ?? 0,
      });
      setSmLog((sm.current?.transitions ?? []).map((x) => `${x.at.toFixed(2)}s  ${x.from} → ${x.to}   (${x.via})`).reverse());
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="moshilab" data-testid="moshi-lab">
      <header className="ml-top">
        <span className="ml-wordmark">MOSHI</span>
        <span className="ml-sub">REDESIGN LAB · one brain, three bodies · pick a runtime</span>
      </header>

      <div className="ml-body">
        <div className="ml-cards">
          {/* ── candidate A ── */}
          <section className="ml-card" data-testid="ml-card-a">
            <div className="ml-card-head">
              <span className="ml-card-name">A · SVG + SPRINGS</span>
              <span className="ml-card-meta">~9 KB · zero deps · cpu {cpu.a.toFixed(2)} ms</span>
            </div>
            <div className="ml-stage">
              <MoshiSvg ref={aStage} size={250} />
              <div className="ml-orb"><MoshiSvg ref={aOrb} size={56} interactive={false} /></div>
            </div>
            <p className="ml-note">The logo, alive. Squash &amp; stretch, lid-snap blinks, a parametric
              singing mouth, per-lobe goo wobble. Themes via the same CSS vars as the topbar mark;
              ports to iOS as plain SVG.</p>
          </section>

          {/* ── candidate B ── */}
          <section className="ml-card" data-testid="ml-card-b">
            <div className="ml-card-head">
              <span className="ml-card-name">B · RIVE WORKALIKE</span>
              <span className="ml-card-meta">A + ~3 KB SM · real Rive ≈ +200 KB wasm · cpu {cpu.b.toFixed(2)} ms</span>
            </div>
            <div className="ml-stage">
              <MoshiSvg ref={bStage} size={250} brain={bBrain.current ?? undefined} />
              <div className="ml-orb"><MoshiSvg ref={bOrb} size={56} interactive={false} /></div>
            </div>
            <p className="ml-note">Same pixels as A — Rive renders flat vectors too. The difference is
              the model: bool/number/trigger <em>inputs</em> resolve states through guarded transitions.
              Try the bools; watch refused transitions in the log.</p>
            <div className="ml-sm">
              <div className="ml-sm-bools">
                {SM_BOOLS.map((b) => (
                  <button key={b} type="button"
                    className={`ml-seg-btn${smBools[b] ? " on" : ""}`}
                    aria-pressed={smBools[b]} data-testid={`sm-bool-${b}`}
                    onClick={() => onSmBool(b)}>{b}</button>
                ))}
              </div>
              <div className="ml-sm-log" data-testid="sm-log">
                {smLog.length === 0 ? <span className="ml-sm-dim">transitions appear here</span>
                  : smLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
              <label className="ml-riv" data-testid="riv-drop">
                <span>DROP A .riv · {rivNote}</span>
                <input type="file" accept=".riv" style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    setRivNote(f
                      ? `${f.name} (${(f.size / 1024).toFixed(1)} KB) — runtime not bundled; npm i @rive-app/canvas when we have a real asset`
                      : "no .riv loaded");
                  }} />
              </label>
            </div>
          </section>

          {/* ── candidate C ── */}
          <section className="ml-card" data-testid="ml-card-c">
            <div className="ml-card-head">
              <span className="ml-card-name">C · TRIMMED 2D SHADER</span>
              <span className="ml-card-meta">~10 KB · WebGL1 · cpu {cpu.c.toFixed(2)} ms</span>
            </div>
            <div className="ml-stage">
              <MoshiGL2D ref={cStage} size={250} mode={glMode} />
              <div className="ml-orb"><MoshiGL2D ref={cOrb} size={56} mode={glMode} interactive={false} /></div>
            </div>
            <p className="ml-note">The exact sticker silhouette as a 2D SDF — the raymarcher&apos;s
              lineage without the 1351 lines. Toggle the shading: the flat twin of A, the clay
              porcelain of the reference renders, or the PS2 crunch we ship today.</p>
            <div className="ml-seg" role="group" aria-label="Shading mode">
              {GL_MODES.map((m) => (
                <button key={m} type="button"
                  className={`ml-seg-btn${glMode === m ? " on" : ""}`}
                  aria-pressed={glMode === m} data-testid={`gl-mode-${m}`}
                  onClick={() => setGlMode(m)}>{m}</button>
              ))}
            </div>
          </section>
        </div>

        {/* ── the shared rack ── */}
        <aside className="ml-rack" aria-label="Shared drives">
          {DRIVES.map((d) => (
            <label className="ml-slider" key={d.key} data-testid={`ctl-${d.key}`}>
              <div className="ml-lbl">
                <span className="ml-name">{d.label}</span>
                <span className="ml-val">{drives[d.key].toFixed(2)}</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={drives[d.key]}
                onChange={(e) => onDrive(d.key, Number(e.target.value))} />
              <span className="ml-hint">{d.hint}</span>
            </label>
          ))}

          <div className="ml-group">
            <div className="ml-lbl"><span className="ml-name">AGENT STATE</span></div>
            <div className="ml-states">
              {MOSHI_STATES.map((s) => (
                <button key={s} type="button"
                  className={`ml-seg-btn${state === s ? " on" : ""}`}
                  aria-pressed={state === s} data-testid={`ctl-state-${s}`}
                  onClick={() => onState(s)}>{s}</button>
              ))}
            </div>
          </div>

          <div className="ml-group">
            <div className="ml-lbl"><span className="ml-name">ONE-SHOTS</span></div>
            <div className="ml-states">
              <button type="button" className="ml-seg-btn" data-testid="ctl-poke" onClick={onPoke}>POKE</button>
              <button type="button" className="ml-seg-btn" data-testid="ctl-celebrate" onClick={onCelebrate}>CELEBRATE</button>
              <button type="button" className={`ml-seg-btn${follow ? " on" : ""}`} aria-pressed={follow}
                data-testid="ctl-follow" onClick={() => setFollow((f) => !f)}>FOLLOW CURSOR</button>
            </div>
          </div>

          <div className="ml-group">
            <div className="ml-lbl"><span className="ml-name">VOICE (voice.js, unchanged)</span></div>
            <div className="ml-states">
              {VOICE_INTENTS.map((v) => (
                <button key={v} type="button"
                  className={`ml-seg-btn${v === "ACK_WORKING" && working ? " on" : ""}`}
                  data-testid={`ctl-voice-${v}`} onClick={() => onVoice(v)}>{v}</button>
              ))}
              <button type="button" className={`ml-seg-btn${voiceOn ? " on" : ""}`} aria-pressed={voiceOn}
                data-testid="ctl-voiceon" onClick={() => setVoiceOn((v) => !v)}>{voiceOn ? "VOICE ON" : "VOICE OFF"}</button>
            </div>
            <span className="ml-hint">first click unlocks audio (autoplay policy)</span>
          </div>

          <div className="ml-judge">
            <span className="ml-name">HOW TO JUDGE</span>
            <ul>
              <li>fidelity to the sticker (all three draw the same geometry)</li>
              <li>character ceiling — poke him, celebrate, watch him sleep</li>
              <li>weight + cpu ms above each stage</li>
              <li>portability: A/B are plain SVG (iOS, site); C needs a GL context</li>
              <li>maintenance: who can tweak him, and in what tool</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
