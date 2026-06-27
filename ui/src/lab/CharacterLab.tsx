// Character Lab — the in-app knob demo. A reviewer opens `?view=character-lab` on the
// dev server and drags sliders to watch Moshi change shape / texture / style / colour in
// real time. It mounts the EXACT vendored moshi.js the product ships (twice: a big stage
// + a 56px presence orb — the same component at the size it sits in the dock), and drives
// it through nothing but the public semantic API. That's the integration story made
// tangible: a canvas + a handful of scalars. No store, no bridge, no engine, no backend.
import { useEffect, useRef, useState } from "react";
import "../vendor/moshi.js";
import "./characterLab.css";
import {
  familyNameAt,
  applyDrive,
  applyMorph,
  applySeed,
  DRIVE_SLIDERS,
  TOGGLES,
  type DriveKey,
  type MoshiApiLike,
} from "./characterLabModel";

type LabMoshi = MoshiApiLike & {
  destroy: () => void;
  poke?: () => void;
  setPose?: (n: string, hold?: number) => unknown;
};
type MoshiCtor = (host: HTMLElement, opts?: Record<string, unknown>) => LabMoshi;

const DEFAULTS = {
  morph: 0, // TAR — the canonical
  seed: 0.5,
  energy: 0.4,
  heat: 0.15,
  mood: 0.6,
  style: "toon",
  quality: "ps2+",
  anatomy: "A",
} as const;

export function CharacterLab() {
  const stageHostRef = useRef<HTMLDivElement>(null);
  const orbHostRef = useRef<HTMLDivElement>(null);
  const stageApiRef = useRef<LabMoshi | null>(null);
  const orbApiRef = useRef<LabMoshi | null>(null);

  const [morph, setMorph] = useState<number>(DEFAULTS.morph);
  const [seed, setSeed] = useState<number>(DEFAULTS.seed);
  const [energy, setEnergy] = useState<number>(DEFAULTS.energy);
  const [heat, setHeat] = useState<number>(DEFAULTS.heat);
  const [mood, setMood] = useState<number>(DEFAULTS.mood);
  const [style, setStyle] = useState<string>(DEFAULTS.style);
  const [quality, setQuality] = useState<string>(DEFAULTS.quality);
  const [anatomy, setAnatomy] = useState<string>(DEFAULTS.anatomy);
  const [autoSweep, setAutoSweep] = useState<boolean>(false);

  const driveState: Record<DriveKey, number> = { energy, heat, mood };
  // Live snapshot of morph for the auto-sweep rAF, so it reads the current value without
  // re-subscribing the loop each frame.
  const morphRef = useRef(morph);
  morphRef.current = morph;

  const apis = (): LabMoshi[] =>
    [stageApiRef.current, orbApiRef.current].filter((a): a is LabMoshi => a != null);

  // ── mount the two real Moshi instances once ────────────────────────────────
  useEffect(() => {
    const Ctor = (window as unknown as { Moshi?: MoshiCtor }).Moshi;
    const stageHost = stageHostRef.current;
    const orbHost = orbHostRef.current;
    if (typeof Ctor !== "function" || !stageHost || !orbHost) return;

    const common = {
      personality: familyNameAt(DEFAULTS.morph),
      seed: DEFAULTS.seed,
      quality: DEFAULTS.quality,
      style: DEFAULTS.style,
    };
    try {
      stageApiRef.current = Ctor(stageHost, { ...common, room: true, interactive: true });
      // the dock-sized twin: identical component, 56px, non-interactive (resDiv:1 = crisp)
      orbApiRef.current = Ctor(orbHost, { ...common, interactive: false, resDiv: 1, maxW: 256, maxH: 256 });
    } catch {
      /* a missing WebGL context must not blank the page */
    }

    // apply the initial drives + anatomy the constructor opts don't cover
    for (const a of apis()) {
      try {
        applyDrive(a, "energy", DEFAULTS.energy);
        applyDrive(a, "heat", DEFAULTS.heat);
        applyDrive(a, "mood", DEFAULTS.mood);
        a.setAnatomy(DEFAULTS.anatomy);
      } catch { /* noop */ }
    }

    // Dev-only debug handle: exposes the live instances so e2e/manual demos can poke
    // them directly (e.g. snap a personality in one frame under a throttled-rAF harness).
    // Dev-gated, so it never ships in the production bundle.
    if (import.meta.env?.DEV) {
      (window as unknown as { __charlab?: unknown }).__charlab = {
        stage: stageApiRef.current,
        orb: orbApiRef.current,
      };
    }

    return () => {
      for (const a of apis()) { try { a.destroy(); } catch { /* noop */ } }
      stageApiRef.current = null;
      orbApiRef.current = null;
      if (import.meta.env?.DEV) {
        try { delete (window as unknown as { __charlab?: unknown }).__charlab; } catch { /* noop */ }
      }
    };
  }, []);

  // ── auto-sweep: walk the MORPH dial hands-free for an unattended demo ───────
  useEffect(() => {
    if (!autoSweep) return;
    let raf = 0;
    const loop = () => {
      const v = (morphRef.current + 0.0016) % 1;
      morphRef.current = v;
      setMorph(v);
      for (const a of apis()) { try { applyMorph(a, v); } catch { /* noop */ } }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [autoSweep]);

  // ── handlers: every change applies to BOTH instances, so the stage and the dock
  //    orb morph in lockstep (the "same component, any size" point). ────────────
  const onMorph = (v: number) => {
    setMorph(v);
    for (const a of apis()) { try { applyMorph(a, v); } catch { /* noop */ } }
  };
  const onSeed = (v: number) => {
    setSeed(v);
    for (const a of apis()) { try { applySeed(a, morphRef.current, v); } catch { /* noop */ } }
  };
  const onDrive = (key: DriveKey, v: number) => {
    if (key === "energy") setEnergy(v);
    else if (key === "heat") setHeat(v);
    else setMood(v);
    for (const a of apis()) { try { applyDrive(a, key, v); } catch { /* noop */ } }
  };
  const onToggle = (key: string, value: string) => {
    if (key === "style") setStyle(value);
    else if (key === "quality") setQuality(value);
    else setAnatomy(value);
    const t = TOGGLES.find((x) => x.key === key);
    for (const a of apis()) { try { t?.apply(a, value); } catch { /* noop */ } }
  };

  const randomize = () => {
    setAutoSweep(false); // else the sweep's next rAF frame clobbers the random result
    const m = Math.random(), sd = Math.random();
    const e = Math.random(), h = Math.random(), md = Math.random();
    setMorph(m); morphRef.current = m; setSeed(sd);
    setEnergy(e); setHeat(h); setMood(md);
    for (const a of apis()) {
      try {
        applySeed(a, m, sd); // family from m + explicit shape seed sd
        applyDrive(a, "energy", e); applyDrive(a, "heat", h); applyDrive(a, "mood", md);
      } catch { /* noop */ }
    }
  };

  const reset = () => {
    setAutoSweep(false);
    setMorph(DEFAULTS.morph); morphRef.current = DEFAULTS.morph;
    setSeed(DEFAULTS.seed); setEnergy(DEFAULTS.energy); setHeat(DEFAULTS.heat); setMood(DEFAULTS.mood);
    setStyle(DEFAULTS.style); setQuality(DEFAULTS.quality); setAnatomy(DEFAULTS.anatomy);
    for (const a of apis()) {
      try {
        applySeed(a, DEFAULTS.morph, DEFAULTS.seed);
        applyDrive(a, "energy", DEFAULTS.energy);
        applyDrive(a, "heat", DEFAULTS.heat);
        applyDrive(a, "mood", DEFAULTS.mood);
        a.setStyle(DEFAULTS.style); a.setQuality(DEFAULTS.quality); a.setAnatomy(DEFAULTS.anatomy);
      } catch { /* noop */ }
    }
  };

  const toggleState: Record<string, string> = { style, quality, anatomy };

  return (
    <div className="charlab" data-testid="character-lab">
      <header className="charlab-top">
        <span className="charlab-wordmark">MOSHI</span>
        <span className="charlab-sub">CHARACTER LAB · the shipping component, driven by a canvas + a few scalars</span>
      </header>

      <div className="charlab-body">
        {/* the stage — the real component, full size + interactive (poke / drag to spin) */}
        <div className="charlab-stage">
          <div ref={stageHostRef} className="charlab-stage-host" data-testid="charlab-stage" role="img" aria-label="Moshi character — drag to spin, click to poke" />
          <div className="charlab-orbwrap">
            <div ref={orbHostRef} className="charlab-orb-host" data-testid="charlab-orb" aria-hidden="true" />
            <span className="charlab-orb-lbl">SAME COMPONENT · 56PX</span>
          </div>
        </div>

        {/* the rack — sliders for the continuous axes, segmented toggles for discrete */}
        <aside className="charlab-rack" aria-label="Character controls">
          <Slider label="MORPH" hint={`texture + colour · ${familyNameAt(morph)}`}
            value={morph} min={0} max={1} step={0.001} onChange={onMorph}
            display={`${familyNameAt(morph)} · ${morph.toFixed(3)}`} testid="ctl-morph" />

          <Slider label="SEED" hint="shape variation in the family"
            value={seed} min={0} max={1} step={0.001} onChange={onSeed}
            display={seed.toFixed(3)} testid="ctl-seed" />

          {DRIVE_SLIDERS.map((s) => (
            <Slider key={s.key} label={s.label} hint={s.hint}
              value={driveState[s.key]} min={0} max={1} step={0.01}
              onChange={(v) => onDrive(s.key, v)} display={driveState[s.key].toFixed(2)}
              testid={`ctl-${s.key}`} />
          ))}

          {TOGGLES.map((t) => (
            <div className="charlab-toggle" key={t.key}>
              <div className="charlab-lbl"><span className="charlab-name">{t.label}</span></div>
              <div className="charlab-seg" role="group" aria-label={t.label}>
                {t.options().map((opt) => (
                  <button key={opt} type="button"
                    className={`charlab-seg-btn${toggleState[t.key] === opt ? " on" : ""}`}
                    aria-pressed={toggleState[t.key] === opt}
                    data-testid={`ctl-${t.key}-${opt}`}
                    onClick={() => onToggle(t.key, opt)}>{opt}</button>
                ))}
              </div>
            </div>
          ))}

          <div className="charlab-actions">
            <button type="button" className="charlab-act" onClick={randomize} data-testid="ctl-randomize">RANDOMIZE</button>
            <button type="button" className="charlab-act" onClick={reset} data-testid="ctl-reset">RESET</button>
            <button type="button" className={`charlab-act${autoSweep ? " on" : ""}`} aria-pressed={autoSweep}
              onClick={() => setAutoSweep((s) => !s)} data-testid="ctl-sweep">
              {autoSweep ? "■ SWEEP" : "▶ AUTO-SWEEP"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Slider(props: {
  label: string; hint: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; display: string; testid: string;
}) {
  return (
    <label className="charlab-slider" data-testid={props.testid}>
      <div className="charlab-lbl">
        <span className="charlab-name">{props.label}</span>
        <span className="charlab-val tc">{props.display}</span>
      </div>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="charlab-hint">{props.hint}</span>
    </label>
  );
}
