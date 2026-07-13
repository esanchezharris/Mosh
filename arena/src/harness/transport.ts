// One shared transport clock for the whole wall — every candidate (glsl canvases and,
// via postMessage, opted-in html iframes) reads the SAME uTime / uPlayhead / playing so
// animated looks compare fairly. Single rAF; components subscribe. Respects reduced-motion.

export interface TransportState { time: number; playhead: number; playing: boolean }

const PERIOD = 6.5; // seconds for the playhead to cross the clip (matches the lab)
const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let state: TransportState = { time: 0, playhead: 0, playing: !reduce };
const subs = new Set<(s: TransportState) => void>();
let raf = 0;
let last = 0;

function loop(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;
  state.time = now / 1000;
  if (state.playing) {
    state.playhead += dt / PERIOD;
    if (state.playhead > 1) state.playhead -= 1;
  }
  for (const fn of subs) fn(state);
  raf = requestAnimationFrame(loop);
}

function ensureRunning() {
  if (!raf) raf = requestAnimationFrame(loop);
}

export const transport = {
  get: () => state,
  subscribe(fn: (s: TransportState) => void): () => void {
    subs.add(fn);
    ensureRunning();
    return () => {
      subs.delete(fn);
    };
  },
  toggle() {
    state.playing = !state.playing;
  },
  setPlaying(v: boolean) {
    state.playing = v;
  },
  setPlayhead(p: number) {
    state.playhead = Math.max(0, Math.min(1, p));
  },
};
