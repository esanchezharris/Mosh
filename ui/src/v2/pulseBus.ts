// Edit-pulse bus — a tiny imperative sink for "a command just landed on this track".
// The v2 shell already glows each lane with its live audio level (`--lvl`, driven off
// the 30Hz `levels` feed); this adds a brief, complementary FLASH when a track is edited
// (mute, drag, trim, plugin add, an agent batch move, …) so the arrangement reacts to
// structural changes the way Moshi reacts to sound.
//
// Deliberately a leaf module with no imports: `store.exec` writes to it (after a command
// succeeds) and the TrackLaneList rAF loop reads from it — exactly the same imperative,
// no-React-re-render path as `--lvl`. Pure decay math so it's unit-testable.

const PULSE_MS = 520; // flash lifetime; tuned to read as a "ping", not a lingering glow
const stamps = new Map<string, number>();

/** Record that `trackId` was just edited. `now` is injectable for tests. */
export function markPulse(trackId: string, now: number = performance.now()): void {
  if (trackId) stamps.set(trackId, now);
}

/** Current flash intensity for a track in 0..1 (quadratic ease-out), 0 once expired. */
export function pulseLevel(trackId: string, now: number): number {
  const t = stamps.get(trackId);
  if (t == null) return 0;
  const dt = now - t;
  if (dt < 0 || dt >= PULSE_MS) return 0;
  const x = dt / PULSE_MS;
  const e = 1 - x;
  return e * e;
}

/** Test/reset hook. */
export function clearPulses(): void {
  stamps.clear();
}

export const __PULSE_MS = PULSE_MS;
