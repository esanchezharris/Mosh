// Moshi on the site: the same splat engine the app's dock draws (vendor/agent-sprites).
// Every <canvas data-splat> becomes a live creature. One shared rAF loop paints only the
// canvases that are on screen; the engine itself is clock-free, so this module owns `t`.
//
//   data-state       idle | thinking | wide | laugh | sleep | notify …   (default idle)
//   data-body        auto | ink | creme | on-accent                      (default auto)
//   data-seed        number: desyncs blinks and gaze between creatures
//   data-pad         inset around the silhouette (default 0.24)
//   data-flat        "false" for the dock's sheen, as the app's dock paints it
//   data-splat-name  handle for getSplat(name)
import './vendor/agent-sprites/engine.js'
import type AgentSpritesApi from './vendor/agent-sprites/index'
import { currentColorway, type Colorway } from './colorway'

type Api = typeof AgentSpritesApi
type Engine = ReturnType<Api['createEngine']>
type Palette = string | { id: string; hex: string; accent: string; voidHex: string }

const INK = '#1B1D1C'
/** The shell's accent per colorway (ui/src/v3/tokens.css): the ink body's mouth. */
const ACCENT: Record<Colorway, string> = { lime: '#C6F542', bone: '#E8E2D6', violet: '#B8A4FF', coral: '#FF8B7A' }
const VOID: Record<Colorway, string> = { lime: '#070709', bone: '#070709', violet: '#0B0914', coral: '#140A08' }

function api(): Api | null {
  const w = globalThis as unknown as { AgentSprites?: Api }
  return w.AgentSprites && typeof w.AgentSprites.createEngine === 'function' ? w.AgentSprites : null
}

function isLightTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light'
}

/** Which palette a creature wears. `auto` is the app's own mapping (ui/src/v3/splat.ts):
 *  bone wears the cream body, every other colorway keeps the ink body with the accent
 *  as its mouth. `on-accent` is for a creature sitting on an accent-filled surface. */
function paletteFor(body: string, colorway: Colorway): Palette {
  const ink: Palette =
    colorway === 'lime' ? 'encre' : { id: `ink-${colorway}`, hex: INK, accent: ACCENT[colorway], voidHex: VOID[colorway] }
  switch (body) {
    case 'ink':
      return ink
    case 'creme':
      return 'creme'
    case 'on-accent':
      // bone's accent is ink on the light theme, so the creature flips to cream there
      return colorway === 'bone' && isLightTheme() ? 'creme' : ink
    default:
      return colorway === 'bone' ? 'creme' : ink
  }
}

export interface SplatHandle {
  /** Change the resting state. */
  setState(state: string): void
  /** Play a state for `seconds`, then return to the resting state. */
  flash(state: string, seconds?: number): void
}

interface Sprite extends SplatHandle {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  engine: Engine
  body: string
  rest: string
  applied: string
  flashState: string
  flashUntil: number
  size: number
  pad: number
  flat: boolean
  visible: boolean
  dirty: boolean
}

const sprites: Sprite[] = []
const named = new Map<string, Sprite>()
let origin = 0
let raf = 0
let reducedMotion = false

const now = (): number => performance.now() / 1000 - origin

function fit(s: Sprite): void {
  const size = Math.round(s.canvas.clientWidth)
  if (size <= 0) return
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  s.size = size
  s.canvas.width = Math.round(size * dpr)
  s.canvas.height = Math.round(size * dpr)
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  s.dirty = true
}

function paint(s: Sprite, t: number, lib: Api): void {
  if (s.size <= 0) return
  const want = s.flashUntil > t ? s.flashState : s.rest
  if (want !== s.applied) {
    s.engine.setState(want, t)
    s.applied = want
  }
  s.ctx.clearRect(0, 0, s.size, s.size)
  lib.drawCanvas(s.ctx, s.engine.sample(t), { size: s.size, paper: 'transparent', flat: s.flat, shadow: false, pad: s.pad })
  s.dirty = false
}

function frame(): void {
  raf = 0
  const lib = api()
  if (!lib) return
  const t = now()
  let animating = false
  for (const s of sprites) {
    if (!s.visible) continue
    if (reducedMotion) {
      // A still: repaint only when something changed, and land state changes instantly
      // by sampling well past the morph.
      const want = s.flashUntil > t ? s.flashState : s.rest
      if (s.dirty || want !== s.applied) {
        if (want !== s.applied) {
          s.engine.setState(want, t - 10)
          s.applied = want
        }
        paint(s, t, lib)
      }
      if (s.flashUntil > t) animating = true
      continue
    }
    paint(s, t, lib)
    animating = true
  }
  if (animating) raf = requestAnimationFrame(frame)
}

function kick(): void {
  if (!raf) raf = requestAnimationFrame(frame)
}

function repalette(): void {
  const colorway = currentColorway()
  for (const s of sprites) {
    s.engine.setColorway(paletteFor(s.body, colorway))
    s.dirty = true
  }
  kick()
}

export function getSplat(name: string): SplatHandle | undefined {
  return named.get(name)
}

export function initSplats(): void {
  const lib = api()
  if (!lib) return
  origin = performance.now() / 1000
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const colorway = currentColorway()

  const visibility =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const s = sprites.find((x) => x.canvas === entry.target)
              if (!s) continue
              s.visible = entry.isIntersecting
              if (s.visible) s.dirty = true
            }
            kick()
          },
          { rootMargin: '80px' },
        )
      : null
  const resize = 'ResizeObserver' in window ? new ResizeObserver(() => { for (const s of sprites) fit(s); kick() }) : null

  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-splat]')) {
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) continue
    const body = canvas.dataset.body ?? 'auto'
    const rest = canvas.dataset.state ?? 'idle'
    const seed = Number(canvas.dataset.seed ?? 7)
    const s: Sprite = {
      canvas,
      ctx,
      engine: lib.createEngine({ colorway: paletteFor(body, colorway), state: rest, seed }),
      body,
      rest,
      applied: rest,
      flashState: rest,
      flashUntil: -1,
      size: 0,
      pad: Number(canvas.dataset.pad ?? 0.24),
      flat: canvas.dataset.flat !== 'false',
      visible: visibility === null,
      dirty: true,
      setState(state) {
        s.rest = state
        kick()
      },
      flash(state, seconds) {
        const dur = seconds ?? lib.STATE_DEFS[state]?.duration ?? 1.7
        s.flashState = state
        s.flashUntil = now() + dur
        kick()
      },
    }
    sprites.push(s)
    if (canvas.dataset.splatName) named.set(canvas.dataset.splatName, s)
    fit(s)
    visibility?.observe(canvas)
    resize?.observe(canvas)
  }

  // Theme and colorway are both attributes on <html>; either one can change a palette.
  new MutationObserver(repalette).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-colorway'],
  })
  kick()
}

/** The hero creature: eyes go wide on hover, a click gets a laugh. */
export function initPoke(): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-splat-poke]')) {
    const name = button.querySelector<HTMLCanvasElement>('canvas[data-splat]')?.dataset.splatName
    const splat = name ? getSplat(name) : undefined
    if (!splat) continue
    button.addEventListener('pointerenter', () => splat.setState('wide'))
    button.addEventListener('pointerleave', () => splat.setState('idle'))
    button.addEventListener('click', () => splat.flash('laugh'))
  }
}
