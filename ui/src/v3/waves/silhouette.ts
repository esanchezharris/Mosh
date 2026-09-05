/** Classic Ableton/PT continuous mirrored peak silhouette. Not RMS bar columns. */

export type PeakPair = readonly [number, number];

export function silhouettePath(peaks: readonly PeakPair[], w: number, h: number): string {
  if (peaks.length === 0 || w <= 0 || h <= 0) return "";
  const mid = h / 2;
  const n = peaks.length;
  const top: string[] = [];
  const bot: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(n - 1, 1)) * w;
    const lo = peaks[i][0];
    const hi = peaks[i][1];
    top.push(`${x.toFixed(2)},${(mid + lo * mid * 0.92).toFixed(2)}`);
    bot.push(`${x.toFixed(2)},${(mid + hi * mid * 0.92).toFixed(2)}`);
  }
  return `M ${top.join(" L ")} L ${[...bot].reverse().join(" L ")} Z`;
}

export function isSilhouettePath(d: string): boolean {
  return d.startsWith("M ") && d.includes(" L ") && d.endsWith(" Z");
}
