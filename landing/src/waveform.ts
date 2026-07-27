// The hero's signature visual: a waveform made of a fixed number of bars,
// grouped into chunks. Idle, it just breathes gently. Every few seconds it
// visibly re-sequences — the same chunks, shuffled into a new order — which
// is the whole thesis drawn as a picture: nothing here is invented, the same
// material just gets rearranged. #scope-state (the HUD label) is updated in
// lockstep so the caption never lies about what's on screen.

const BAR_COUNT = 64
const CHUNK_COUNT = 8
const BARS_PER_CHUNK = BAR_COUNT / CHUNK_COUNT
const RECOMBINE_EVERY_MS = 6400
const RECOMBINE_DURATION_MS = 900
const MIN_BAR = 0.05

function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A deterministic "found audio" silhouette: a handful of overlapping
 *  transients under a phrase-shaped envelope, not uniform noise and not a
 *  clean sine — reads as a real take, not a decorative squiggle. */
function generateWaveform(n: number, seed: number): number[] {
  const rand = mulberry32(seed)
  const noteCount = 7 + Math.floor(rand() * 5)
  const centers: number[] = Array.from({ length: noteCount }, () => rand())
  const widths = centers.map(() => 0.035 + rand() * 0.05)
  const amps = centers.map(() => 0.55 + rand() * 0.45)

  const values: number[] = []
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1)
    let v = 0
    for (let c = 0; c < centers.length; c++) {
      const d = x - centers[c]
      v += amps[c] * Math.exp(-(d * d) / (2 * widths[c] * widths[c]))
    }
    v += rand() * 0.12
    const envelope = Math.pow(Math.sin(Math.PI * Math.min(Math.max(x, 0), 1)), 0.55)
    values.push(Math.min(1, v * 0.55 * envelope + envelope * 0.08))
  }
  return values
}

function chunksOf(values: number[]): number[][] {
  const chunks: number[][] = []
  for (let c = 0; c < CHUNK_COUNT; c++) {
    chunks.push(values.slice(c * BARS_PER_CHUNK, (c + 1) * BARS_PER_CHUNK))
  }
  return chunks
}

function flatten(chunks: number[][], order: number[]): number[] {
  const out: number[] = []
  for (const idx of order) out.push(...chunks[idx])
  return out
}

function shuffledOrder(current: number[], rand: () => number): number[] {
  const order = current.slice()
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  // Guarantee a visible change — a shuffle that lands back on the identity
  // permutation would just look like nothing happened.
  const unchanged = order.every((v, i) => v === current[i])
  if (unchanged) {
    ;[order[0], order[1]] = [order[1], order[0]]
  }
  return order
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export function initWaveform(container: HTMLElement): void {
  const canvas = container.querySelector<HTMLCanvasElement>('canvas')
  const stateEl = container.querySelector<HTMLElement>('#scope-state')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const styles = getComputedStyle(document.documentElement)
  const traceColor = styles.getPropertyValue('--scope-trace').trim() || '#8cff6b'
  const glowColor = styles.getPropertyValue('--scope-trace-glow').trim() || 'rgba(140,255,107,0.55)'

  const seed = Math.floor(Math.random() * 2 ** 31)
  const baseValues = generateWaveform(BAR_COUNT, seed)
  const chunks = chunksOf(baseValues)

  let order = chunks.map((_, i) => i)
  let fromValues = flatten(chunks, order)
  let toValues = fromValues
  let animStart = 0
  let animating = false

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let width = 0
  let height = 0
  let dpr = Math.min(window.devicePixelRatio || 1, 2)

  function resize(): void {
    const rect = container.getBoundingClientRect()
    width = Math.max(1, rect.width)
    height = Math.max(1, rect.height)
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas!.width = Math.round(width * dpr)
    canvas!.height = Math.round(height * dpr)
    canvas!.style.width = `${width}px`
    canvas!.style.height = `${height}px`
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function setState(label: string): void {
    if (stateEl) stateEl.textContent = label
  }

  function draw(displayValues: number[], t: number): void {
    ctx!.clearRect(0, 0, width, height)

    const gap = width / BAR_COUNT
    const barW = Math.max(1.5, gap * 0.42)
    const centerY = height / 2
    const maxH = height * 0.72

    // faint zero-line, hardware-scope authenticity
    ctx!.strokeStyle = glowColor
    ctx!.globalAlpha = 0.16
    ctx!.lineWidth = 1
    ctx!.beginPath()
    ctx!.moveTo(0, centerY)
    ctx!.lineTo(width, centerY)
    ctx!.stroke()
    ctx!.globalAlpha = 1

    const path = new Path2D()
    for (let i = 0; i < BAR_COUNT; i++) {
      let v = Math.max(MIN_BAR, displayValues[i])
      if (!reducedMotion) {
        v *= 0.94 + 0.06 * Math.sin(t * 0.0016 + i * 0.45)
      }
      const h = Math.max(2, v * maxH)
      const x = i * gap + (gap - barW) / 2
      const r = barW / 2
      const y = centerY - h / 2
      // rounded bar
      path.moveTo(x, y + r)
      path.arcTo(x, y, x + r, y, r)
      path.arcTo(x + barW, y, x + barW, y + r, r)
      path.lineTo(x + barW, y + h - r)
      path.arcTo(x + barW, y + h, x + barW - r, y + h, r)
      path.arcTo(x, y + h, x, y + h - r, r)
      path.closePath()
    }

    ctx!.fillStyle = traceColor
    ctx!.shadowColor = glowColor
    ctx!.shadowBlur = 14
    ctx!.fill(path)
    ctx!.shadowBlur = 0
  }

  let rafId = 0
  let lastRecombine = 0

  function frame(t: number): void {
    if (animating) {
      const elapsed = t - animStart
      const p = Math.min(1, elapsed / RECOMBINE_DURATION_MS)
      const eased = easeInOutCubic(p)
      const current = fromValues.map((v, i) => v + (toValues[i] - v) * eased)
      draw(current, t)
      if (p >= 1) {
        animating = false
        fromValues = toValues
        setState('HOLDING')
      }
    } else {
      draw(fromValues, t)
      if (!reducedMotion && t - lastRecombine > RECOMBINE_EVERY_MS) {
        lastRecombine = t
        const rand = mulberry32((Math.random() * 2 ** 31) | 0)
        order = shuffledOrder(order, rand)
        toValues = flatten(chunks, order)
        animStart = t
        animating = true
        setState('RE-SEQUENCING…')
      }
    }
    if (!reducedMotion) rafId = requestAnimationFrame(frame)
  }

  resize()
  setState('HOLDING')

  if (reducedMotion) {
    draw(fromValues, 0)
  } else {
    lastRecombine = performance.now()
    rafId = requestAnimationFrame(frame)
  }

  const ro = new ResizeObserver(() => {
    resize()
    if (reducedMotion) draw(fromValues, 0)
  })
  ro.observe(container)

  document.addEventListener('visibilitychange', () => {
    if (reducedMotion) return
    if (document.hidden) {
      cancelAnimationFrame(rafId)
    } else {
      lastRecombine = performance.now()
      rafId = requestAnimationFrame(frame)
    }
  })
}
