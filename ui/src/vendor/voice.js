// THE VOICE — Moshi's non-verbal voice. A small, cute creature that coos and
// chirps (think Wall-E / a friendly critter), NOT words. He communicates by
// emitting an expressive SOUND co-fired with a body pose; a text bubble pops
// only when words are essential. A coo alone is ambiguous — posture + pitch
// contour carry the meaning.
//
// IN-KEY: his voice sings in the SAME musical key as the song. Every earcon is
// written in SCALE DEGREES (not absolute Hz) and snapped to the current key, so
// he's always consonant with what's playing. Host sets it with `setKey(...)`.
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │ STUB — WHERE THE SONG KEY COMES FROM.                                 │
//   │ The engine does NOT track a musical key yet. It stores tempo +        │
//   │ time-signature (TempoSequence; MoshOps cmdSetTempo / cmdInsertTimeSig)│
//   │ and a `tempoKeyContext` PLACEHOLDER string in the RenderLayer cache    │
//   │ fingerprint (src/state/RenderLayer.h ~L58). When a real key signature  │
//   │ is added to the engine/snapshot, surface it on the `mosh_event` feed   │
//   │ (e.g. {type:'key', tonic:'A', mode:'minor'}) and the host calls        │
//   │ voice.setKey(tonic, mode). Until then the lab sets a demo key.         │
//   └─────────────────────────────────────────────────────────────────────┘
//
// Doctrine: moshi.js stays PURE (no audio). The voice is a sibling HOST module,
// like brain.js. Zero dependencies, classic script, one global. Web Audio only.
(function () {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  // seeded fract-noise — same idiom as moshi.js mkHash, so (intent,seed) reproduces
  function mkHash(seed) {
    const s = Math.floor(seed * 9973) + 17;
    let k = 0;
    return () => { const x = Math.sin(s * 12.9898 + (k++) * 78.233) * 43758.5453; return x - Math.floor(x); };
  }

  // --- musical key ---
  const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10],
    pentatonic: [0, 3, 5, 7, 10], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // THE PHRASES — one row per intent. Cute/organic register.
  //   contour(A, r) -> [{ d, t, glide }]   d = scale-degree offset (semitones)
  //     from the tonic; SNAPPED to the key at render → always in tune.
  //   osc: oscillator types (sine/triangle = soft). stack: 2nd-osc semitone
  //   offset (octave doubling); detune: 2nd-osc cents (gentle chorus warmth).
  //   No bit-crush here (organic, not digital); glides are smooth portamento.
  const PHRASES = {
    // understood, on it now — a perky little rising coo
    ACK_GOT_IT: {
      osc: ['triangle', 'sine'], detune: 7, stackGain: 0.4, crush: false, level: 0.85,
      adsr: { a: 0.02, d: 0.05, s: 0.7, r: 0.12 }, vib: { rate: () => 5, depth: () => 8 },
      formant: { type: 'lowpass', from: 900, to: 1500, q: 0.8 },
      contour: (A, r) => [{ d: 0, t: 0.10, glide: false }, { d: 4, t: 0.10, glide: true }, { d: 4, t: 0.10, glide: false }],
    },
    // understood, now working/thinking — soft low burble (LOOPABLE)
    ACK_WORKING: {
      osc: ['sine', 'triangle'], detune: 5, stackGain: 0.3, crush: false, level: 0.45, loop: true,
      adsr: { a: 0.05, d: 0.06, s: 0.5, r: 0.10 }, vib: { rate: () => 3.5, depth: () => 6 },
      formant: { type: 'lowpass', from: 800, to: 1100, q: 0.7 },
      contour: (A, r) => { const n = 4 + Math.floor(r() * 3), segs = [];
        for (let i = 0; i < n; i++) segs.push({ d: -12 + Math.round((-2 + r() * 4)), t: 0.10 + r() * 0.05, glide: true });
        return segs; },
    },
    // executed / success — a happy rising arpeggio (co-fires celebrate())
    DONE: {
      osc: ['triangle', 'sine'], stack: 12, stackGain: 0.35, detune: 4, crush: false, level: 0.95,
      adsr: { a: 0.015, d: 0.05, s: 0.8, r: 0.22 }, vib: { rate: () => 6, depth: () => 10 },
      formant: { type: 'lowpass', from: 1000, to: 2200, q: 0.9 },
      contour: (A, r) => [0, 2, 4, 7].map((d, i, a) => ({ d, t: i < a.length - 1 ? 0.08 : 0.24, glide: false })),
    },
    // unclear, need follow-up — a rising, curious "?" coo
    HUH: {
      osc: ['sine'], crush: false, level: 0.8,
      adsr: { a: 0.025, d: 0.05, s: 0.6, r: 0.14 }, vib: { rate: () => 5, depth: () => 12 },
      formant: { type: 'bandpass', from: 700, to: 1500, q: 1.2 },
      contour: (A, r) => [{ d: 0, t: 0.10, glide: false }, { d: -2, t: 0.07, glide: true }, { d: 7, t: 0.18, glide: true }],
    },
    // disagree / decline — a gentle little downward "mn-mn"
    NUH: {
      osc: ['triangle', 'sine'], detune: 6, stackGain: 0.3, crush: false, level: 0.8,
      adsr: { a: 0.02, d: 0.05, s: 0.5, r: 0.12 }, vib: null,
      formant: { type: 'lowpass', from: 1200, to: 650, q: 0.8 },
      contour: (A, r) => [{ d: 0, t: 0.12, glide: false }, { d: -3, t: 0.12, glide: true }, { d: -5, t: 0.08, glide: true }],
    },
    // error — a soft, sad "awww" that deflates (cute, not harsh)
    UHOH: {
      osc: ['sine', 'triangle'], detune: 8, stackGain: 0.4, crush: false, level: 0.85,
      adsr: { a: 0.02, d: 0.07, s: 0.45, r: 0.26 }, vib: { rate: () => 4, depth: () => 14 },
      formant: { type: 'lowpass', from: 1100, to: 500, q: 0.8 },
      contour: (A, r) => [{ d: 3, t: 0.10, glide: false }, { d: -12, t: 0.34, glide: true }],
    },
    // hello — a friendly up-down lilt
    GREET: {
      osc: ['triangle', 'sine'], detune: 6, stackGain: 0.4, crush: false, level: 0.9,
      adsr: { a: 0.015, d: 0.04, s: 0.7, r: 0.10 }, vib: { rate: () => 6, depth: () => 9 },
      formant: { type: 'bandpass', from: 1200, to: 1900, q: 1.0 },
      contour: (A, r) => [{ d: 0, t: 0.07, glide: false }, { d: 7, t: 0.08, glide: true }, { d: 4, t: 0.11, glide: true }],
    },
    // to-himself ambient mumble — soft, low, understated
    IDLE_MURMUR: {
      osc: ['sine'], crush: false, level: 0.25,
      adsr: { a: 0.04, d: 0.06, s: 0.4, r: 0.12 }, vib: null,
      formant: { type: 'lowpass', from: 700, to: 700, q: 0.7 },
      contour: (A, r) => { const n = 2 + Math.floor(r() * 2), segs = [];
        for (let i = 0; i < n; i++) segs.push({ d: -12 + Math.round((-1 + r() * 3)), t: 0.09 + r() * 0.04, glide: true });
        return segs; },
    },
  };

  function MoshiVoice(opts) {
    opts = opts || {};
    let ctx = null, master = null;
    let masterVol = opts.master != null ? opts.master : 0.7;
    let enabled = opts.enabled !== false;
    let tonicMidi = 69;                 // A4 — neutral default until the host sets the song key
    let scale = SCALES.minor;
    const CAP = 6;
    const live = new Set();
    const crushCache = {};
    let loopActive = false, loopIntent = null, loopOpts = null, loopTimer = 0;

    function crushCurve(bits) {
      if (crushCache[bits]) return crushCache[bits];
      const levels = Math.pow(2, bits), n = 1024, c = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.round(x * levels) / levels; }
      return (crushCache[bits] = c);
    }
    const ready = () => !!(ctx && ctx.state === 'running');

    // snap a semitone offset to the current scale, then to Hz from the tonic
    function snap(semis) {
      const r = Math.round(semis), pc = ((r % 12) + 12) % 12, oct = Math.floor(r / 12);
      let best = scale[0], bd = 99;
      for (const s of scale) { const d = Math.abs(s - pc); if (d < bd) { bd = d; best = s; } }
      return oct * 12 + best;
    }
    const degHz = d => mtof(tonicMidi + snap(d));

    function unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = masterVol; master.connect(ctx.destination);
        // silent 1-sample kick — nudges some browsers from 'suspended' to 'running'
        try { const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 1, 22050); b.connect(ctx.destination); b.start(0); } catch (e) {}
      }
      if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    }

    function scheduleFreq(param, segs, t0, tempo, pitchMul, ratio, step) {
      let t = t0, prev = Math.max(1, segs[0].f * pitchMul * ratio);
      param.setValueAtTime(prev, t);
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], dur = Math.max(0.01, s.t * tempo), target = Math.max(1, s.f * pitchMul * ratio);
        if (s.glide && step > 0) {
          const n = Math.max(1, Math.round(dur / step));
          for (let j = 1; j <= n; j++) param.setValueAtTime(Math.max(1, prev + (target - prev) * (j / n)), t + dur * (j / n));
        } else if (s.glide) {
          param.linearRampToValueAtTime(target, t + dur);
        } else {
          param.setValueAtTime(target, t);
        }
        prev = target; t += dur;
      }
      return t - t0;
    }

    function play(intent, o) {
      o = o || {};
      const spec = PHRASES[intent];
      if (!spec || !enabled || !ctx || live.size >= CAP) return null;
      // resume if the context is still waking from the gesture; schedule anyway —
      // a suspended ctx's currentTime is frozen, so the note fires when it resumes
      // (the gate used to require 'running', which silenced the very first click).
      if (ctx.state !== 'running' && ctx.resume) ctx.resume();
      const h = mkHash(o.seed == null ? Math.random() : o.seed);
      const A = { valence: clamp(o.affect && o.affect.valence != null ? o.affect.valence : 0, -1, 1),
                  arousal: clamp(o.affect && o.affect.arousal != null ? o.affect.arousal : 0.5, 0, 1) };
      const tempo = 1.25 - 0.5 * A.arousal, pitchMul = 0.9 + 0.35 * A.arousal;
      const t0 = ctx.currentTime + 0.02;
      // contour in scale degrees → snap to the key → Hz
      const segs = spec.contour(A, h).map(s => ({ f: degHz(s.d), t: s.t, glide: s.glide }));

      const filt = ctx.createBiquadFilter();
      filt.type = spec.formant.type; filt.Q.value = spec.formant.q * (0.7 + 0.6 * A.arousal);
      const amp = ctx.createGain(); amp.gain.value = 0;
      const bus = ctx.createGain(); bus.gain.value = spec.level;
      let crush = null;
      if (spec.crush !== false) { crush = ctx.createWaveShaper(); crush.curve = crushCurve(spec.crushBits || 6); crush.oversample = 'none'; filt.connect(crush); crush.connect(amp); }
      else filt.connect(amp);
      amp.connect(bus); bus.connect(master);

      const oscs = [];
      let dur = 0;
      spec.osc.forEach((type, i) => {
        const osc = ctx.createOscillator(); osc.type = type;
        const og = ctx.createGain(); og.gain.value = i === 0 ? 1 : (spec.stackGain || 0.4);
        osc.connect(og); og.connect(filt);
        const ratio = (i > 0 && spec.stack) ? Math.pow(2, spec.stack / 12) : 1;
        if (i > 0 && spec.detune) osc.detune.value = spec.detune;     // gentle chorus warmth
        dur = scheduleFreq(osc.frequency, segs, t0, tempo, pitchMul, ratio, spec.step || 0);
        oscs.push(osc);
      });

      let lfo = null;
      if (spec.vib) {
        lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = spec.vib.rate(A);
        const lg = ctx.createGain(); lg.gain.value = spec.vib.depth(A) * (0.6 + 0.8 * A.arousal);
        lfo.connect(lg); oscs.forEach(osc => lg.connect(osc.detune));
      }

      const fb = 0.7 + 0.6 * A.arousal;
      filt.frequency.setValueAtTime(Math.max(40, spec.formant.from), t0);
      filt.frequency.linearRampToValueAtTime(Math.max(40, spec.formant.to * fb), t0 + dur);

      const ad = spec.adsr, relStart = Math.max(t0 + ad.a + ad.d, t0 + dur - ad.r);
      amp.gain.setValueAtTime(0, t0);
      amp.gain.linearRampToValueAtTime(1, t0 + ad.a);
      amp.gain.linearRampToValueAtTime(ad.s, t0 + ad.a + ad.d);
      amp.gain.setValueAtTime(ad.s, relStart);
      amp.gain.linearRampToValueAtTime(0, relStart + ad.r);

      const tEnd = relStart + ad.r + 0.02;
      oscs.forEach(osc => { osc.start(t0); osc.stop(tEnd); });
      if (lfo) { lfo.start(t0); lfo.stop(tEnd); }

      const handle = {
        dur: tEnd - t0,
        stop() { try { const now = ctx.currentTime; amp.gain.cancelScheduledValues(now);
          amp.gain.setValueAtTime(Math.max(0.0001, amp.gain.value), now);
          amp.gain.linearRampToValueAtTime(0, now + 0.03);
          oscs.forEach(osc => osc.stop(now + 0.05)); if (lfo) lfo.stop(now + 0.05); } catch (e) {} },
      };
      live.add(handle);
      oscs[0].onended = () => {
        try { filt.disconnect(); if (crush) crush.disconnect(); amp.disconnect(); bus.disconnect();
          oscs.forEach(osc => osc.disconnect()); if (lfo) lfo.disconnect(); } catch (e) {}
        live.delete(handle);
      };
      return handle;
    }

    function scheduleLoopCycle() {
      if (!loopActive) return;
      const hnd = play(loopIntent, { affect: loopOpts.affect, seed: Math.random() });
      const ms = hnd ? Math.max(140, hnd.dur * 1000 - 40) : 480;
      loopTimer = setTimeout(scheduleLoopCycle, ms);
    }
    function stopLoopNow() { loopActive = false; loopIntent = null; clearTimeout(loopTimer); }

    return {
      unlock,
      isReady: ready,
      play,
      // set the musical key so his voice matches the song. name: 'A'/'C#'/… or a
      // raw MIDI number; mode: a key in SCALES; octave for the tonic (default 4).
      setKey(name, mode, octave) {
        if (typeof name === 'number') tonicMidi = name;
        else if (name != null && NOTE_PC[name] != null) tonicMidi = 12 * ((octave == null ? 4 : octave) + 1) + NOTE_PC[name];
        if (mode && SCALES[mode]) scale = SCALES[mode];
        return this;
      },
      key() { const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const mode = Object.keys(SCALES).find(k => SCALES[k] === scale) || 'minor';
        return { tonic: names[((tonicMidi % 12) + 12) % 12], midi: tonicMidi, mode }; },
      startLoop(intent, o) {
        if (loopActive && loopIntent === intent) return this;
        stopLoopNow(); loopActive = true; loopIntent = intent; loopOpts = o || {};
        unlock(); scheduleLoopCycle(); return this;
      },
      stopLoop() { stopLoopNow(); return this; },
      setEnabled(b) { enabled = !!b; if (!enabled) { stopLoopNow(); this.stopAll(); } return this; },
      setMaster(v) { masterVol = clamp(+v, 0, 1); if (master) master.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.03); return this; },
      stopAll() { live.forEach(h => h.stop()); return this; },
      destroy() { stopLoopNow(); this.stopAll(); if (ctx && ctx.close) try { ctx.close(); } catch (e) {} ctx = null; return this; },
      get liveCount() { return live.size; },
    };
  }

  MoshiVoice.INTENTS = Object.keys(PHRASES);
  MoshiVoice.SCALES = Object.keys(SCALES);
  window.MoshiVoice = MoshiVoice;
})();
