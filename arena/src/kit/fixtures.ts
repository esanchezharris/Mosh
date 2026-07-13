// ============================================================================
// SHARED FIXTURES — identical musical content so every candidate is judged on the
// same material, not one lucky clip. The data-texture generators are ported from
// mosh-material-lab-v3 but SEEDED (deterministic) so the wall is stable across
// reloads. The shell fixture is a small tracks/clips snapshot (shaped like Mosh's
// real snapshot) for whole-shell HTML candidates to render a believable arrangement.
// ============================================================================

export const NCOLS = 192;
export const BEATS = 16;

/** deterministic PRNG so fixtures never shuffle between renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureData { mode: 0 | 1 | 2; w: number; data: Float32Array; count: number; ncols: number; beats: number; }

// audio: NCOLS×1 RGBA = (amp, lowBand, midBand, highBand)
function genAudio(rnd: () => number): { w: number; data: Float32Array; count: number } {
  const d = new Float32Array(NCOLS * 4);
  for (let i = 0; i < NCOLS; i++) {
    const t = i / NCOLS;
    const beatPh = (t * BEATS) % 1;
    const onBeat = Math.pow(1 - beatPh, 3);
    const kick = Math.pow(Math.max(0, Math.sin(t * Math.PI * BEATS)), 6);
    let amp = (0.3 + 0.5 * onBeat + 0.25 * rnd()) * (0.7 + 0.3 * Math.sin(t * 6.28 * 2));
    if (i % (NCOLS / BEATS | 0) < 2) amp = Math.min(1, amp + 0.35);
    d[i * 4] = Math.min(1, amp);
    d[i * 4 + 1] = 0.3 + 0.7 * kick + 0.15 * rnd();
    d[i * 4 + 2] = 0.35 + 0.4 * Math.sin(t * 9 + 1.7) ** 2 + 0.15 * rnd();
    d[i * 4 + 3] = 0.15 + 0.6 * (rnd() < 0.4 ? rnd() : 0.15);
  }
  for (let i = 1; i < NCOLS - 1; i++) d[i * 4] = (d[(i - 1) * 4] + d[i * 4] * 2 + d[(i + 1) * 4]) / 4;
  return { w: NCOLS, data: d, count: 0 };
}

// midi: N×1 RGBA = (start, dur, pitch01, velocity)
function genMidi(rnd: () => number): { w: number; data: Float32Array; count: number } {
  const sc = [0, 2, 3, 5, 7, 8, 10];
  const rb = 45 + ((rnd() * 5) | 0);
  const pr = [0, -3, 3, -1].map((x) => rb + x);
  const N: number[][] = [];
  for (let bar = 0; bar < 4; bar++) {
    const r = pr[bar];
    const dg = [0, 2, 4].concat(rnd() < 0.5 ? [6] : []);
    dg.forEach((g) => N.push([bar * 0.25 + 0.005, 0.235, r + sc[g % 7] + 12 * ((g / 7) | 0), 0.5 + rnd() * 0.4]));
  }
  for (let m = 0; m < 8; m++) {
    const p = rb + 24 + sc[(rnd() * 7) | 0] + (rnd() < 0.3 ? 12 : 0);
    N.push([m * 0.125 + 0.01 + rnd() * 0.02, 0.06 + rnd() * 0.05, p, 0.6 + rnd() * 0.4]);
  }
  const lo = 38, hi = 90, d = new Float32Array(64 * 4);
  N.slice(0, 64).forEach((n, i) => {
    d[i * 4] = n[0]; d[i * 4 + 1] = n[1]; d[i * 4 + 2] = (n[2] - lo) / (hi - lo); d[i * 4 + 3] = n[3];
  });
  return { w: 64, data: d, count: Math.min(N.length, 64) };
}

// drums: N×1 RGBA = (x01, lane, velocity, _)
function genDrums(rnd: () => number): { w: number; data: Float32Array; count: number } {
  const h: number[][] = [];
  for (let s = 0; s < 16; s++) {
    if (s % 4 === 0 || (s === 14 && rnd() < 0.5)) h.push([s, 0, 0.9 + rnd() * 0.1]);
    if (s === 4 || s === 12) h.push([s, 1, 0.85 + rnd() * 0.15]);
    h.push([s, 2, s % 2 ? 0.25 + rnd() * 0.25 : 0.5 + rnd() * 0.35]);
    if (rnd() < 0.22) h.push([s, 3, 0.4 + rnd() * 0.5]);
  }
  const d = new Float32Array(64 * 4);
  h.slice(0, 64).forEach((x, i) => {
    d[i * 4] = (x[0] + 0.5) / 16; d[i * 4 + 1] = x[1]; d[i * 4 + 2] = x[2]; d[i * 4 + 3] = 0;
  });
  return { w: 64, data: d, count: Math.min(h.length, 64) };
}

export function buildFixture(mode: 0 | 1 | 2, seed = 0x51ce): FixtureData {
  const rnd = mulberry32(seed + mode * 977);
  const g = mode === 0 ? genAudio(rnd) : mode === 1 ? genMidi(rnd) : genDrums(rnd);
  return { mode, w: g.w, data: g.data, count: g.count, ncols: NCOLS, beats: BEATS };
}

export const MODE_NAMES = ["audio", "midi", "drums"] as const;

// ── the shell fixture: a small, realistic arrangement for whole-shell HTML candidates.
// Shaped like Mosh's real snapshot (tracks → clips), sourced from ui/src/bridge.mock.ts's
// seed so candidates render believable content and winners map straight onto real data.
export interface ShellClip { id: string; name: string; type: "wave" | "midi" | "drum"; startBeat: number; lengthBeats: number; }
export interface ShellTrack { id: string; name: string; type: "audio" | "drum" | "group"; color?: string; clips: ShellClip[]; volumeDb: number; muted?: boolean; solo?: boolean; }
export interface ShellFixture { name: string; tempo: number; timeSig: string; key: string; bars: number; tracks: ShellTrack[]; }

export const SHELL_FIXTURE: ShellFixture = {
  name: "midnight drive",
  tempo: 122,
  timeSig: "4/4",
  key: "F min",
  bars: 16,
  tracks: [
    {
      id: "t-drums", name: "Drums", type: "drum", volumeDb: -3.5, clips: [
        { id: "c-d1", name: "break", type: "drum", startBeat: 0, lengthBeats: 16 },
        { id: "c-d2", name: "break", type: "drum", startBeat: 16, lengthBeats: 16 },
        { id: "c-d3", name: "fill", type: "drum", startBeat: 48, lengthBeats: 8 },
      ],
    },
    {
      id: "t-bass", name: "Bass", type: "audio", volumeDb: -5, clips: [
        { id: "c-b1", name: "sub", type: "midi", startBeat: 0, lengthBeats: 32 },
        { id: "c-b2", name: "sub", type: "midi", startBeat: 40, lengthBeats: 16 },
      ],
    },
    {
      id: "t-keys", name: "Keys", type: "audio", volumeDb: -6.5, clips: [
        { id: "c-k1", name: "rhodes", type: "wave", startBeat: 8, lengthBeats: 24 },
        { id: "c-k2", name: "rhodes", type: "wave", startBeat: 40, lengthBeats: 20 },
      ],
    },
    {
      id: "t-vox", name: "Vox", type: "audio", volumeDb: -4, solo: false, clips: [
        { id: "c-v1", name: "hook", type: "wave", startBeat: 16, lengthBeats: 16 },
        { id: "c-v2", name: "verse", type: "wave", startBeat: 40, lengthBeats: 24 },
      ],
    },
  ],
};
