// Scales and paths for the panels' SVG plots. Pure, so the geometry is unit-tested.

export type Scale = { to: (v: number) => number; from: (px: number) => number };

/** A logarithmic frequency axis: lo..hi Hz onto 0..width. */
export function freqScale(lo: number, hi: number, width: number): Scale {
  const a = Math.log(lo), b = Math.log(hi);
  return {
    to: (hz) => ((Math.log(Math.max(hz, 1e-6)) - a) / (b - a)) * width,
    from: (x) => Math.exp(a + (x / width) * (b - a)),
  };
}

/** A linear axis, top = `max`: max..min onto 0..height (SVG y grows downward). */
export function linScale(min: number, max: number, height: number): Scale {
  return {
    to: (v) => ((max - v) / (max - min)) * height,
    from: (y) => max - (y / height) * (max - min),
  };
}

/** A polyline path through `n` samples of `fn` across the x scale's domain, with each y
 *  clamped to [yLo, yHi] pixels so a deep notch does not draw off the plot. */
export function curvePath(fn: (x: number) => number, xs: readonly number[], x: Scale, y: Scale, yLo = -1e6, yHi = 1e6): string {
  return xs.map((v, i) => {
    const px = x.to(v), py = Math.min(yHi, Math.max(yLo, y.to(fn(v))));
    return `${i === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
  }).join(" ");
}

/** The fill under a curve down (or up) to a baseline pixel, closed. */
export function fillPath(curve: string, x0: number, x1: number, baseY: number): string {
  if (!curve) return "";
  return `${curve} L${x1.toFixed(2)} ${baseY.toFixed(2)} L${x0.toFixed(2)} ${baseY.toFixed(2)} Z`;
}

/** Where a client point lands in an SVG's viewBox coordinates. */
export function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox?.baseVal;
  const w = vb && vb.width ? vb.width : rect.width, h = vb && vb.height ? vb.height : rect.height;
  return {
    x: (vb?.x ?? 0) + ((clientX - rect.left) / (rect.width || 1)) * w,
    y: (vb?.y ?? 0) + ((clientY - rect.top) / (rect.height || 1)) * h,
  };
}
