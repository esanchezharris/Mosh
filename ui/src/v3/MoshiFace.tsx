import { useEffect, useRef } from "react";
import "../vendor/agent-sprites/engine.js";
import type AgentSpritesApi from "../vendor/agent-sprites/index";
import { useSettings } from "../settings/store";
import { colorwayAttr, type V3Colorway } from "./colorway";
import { splatColorwayFor, splatStateFor, type DockMood, type SplatState } from "./splat";

type Api = typeof AgentSpritesApi;
const api = (): Api | null => {
  const w = globalThis as unknown as { AgentSprites?: Api };
  return w.AgentSprites && typeof w.AgentSprites.createEngine === "function" ? w.AgentSprites : null;
};

const SIZE = 64;

/** Moshi in the dock: the splat (vendor/agent-sprites, the owner's Grok-Bot-built avatar).
 *  A canvas driven by the clock-free engine; the mood props pick its state, and a
 *  celebrate tick plays one laugh (STATE_DEFS.laugh.duration) before returning. The engine
 *  never sees RECORDING: a recording-safe dock puts him to sleep, nothing more. */
export function MoshiFace({ celebrateTick, mood }: { celebrateTick: number; mood: DockMood }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorway = colorwayAttr(useSettings((s) => s.get("colorway")));
  const want = useRef<{ state: SplatState; colorway: V3Colorway; laughUntil: number }>({
    state: splatStateFor(mood), colorway, laughUntil: -1,
  });
  want.current.state = splatStateFor(mood);
  want.current.colorway = colorway;
  const engineRef = useRef<ReturnType<Api["createEngine"]> | null>(null);
  const originRef = useRef<number>(0);
  const lastCelebrate = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const sprites = api();
    if (!canvas || !sprites) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;   // jsdom and other contexts without 2D canvas: the tile stays empty
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;

    const engine = sprites.createEngine({ colorway: splatColorwayFor(colorway), state: want.current.state, seed: 7 });
    engineRef.current = engine;
    originRef.current = performance.now() / 1000;
    const applied: { state: string; colorway: V3Colorway } = { state: want.current.state, colorway };
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, stopped = false;

    const paint = (nowMs: number) => {
      if (stopped) return;
      const t = nowMs / 1000 - originRef.current;
      const laughing = want.current.laughUntil > t;
      const nextState = laughing ? "laugh" : want.current.state;
      if (applied.state !== nextState) { engine.setState(nextState, t); applied.state = nextState; }
      if (applied.colorway !== want.current.colorway) {
        engine.setColorway(splatColorwayFor(want.current.colorway));
        applied.colorway = want.current.colorway;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      sprites.drawCanvas(ctx, engine.sample(t), { size: SIZE, paper: "transparent", flat: false, shadow: false, pad: 0.22 });
      canvas.dataset.state = applied.state;
      if (!reduced) raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => { stopped = true; if (raf) cancelAnimationFrame(raf); engineRef.current = null; };
    // The engine is created once per mount; colorway and mood changes ride want.current.
  }, []);

  useEffect(() => {
    if (celebrateTick > 0 && celebrateTick !== lastCelebrate.current) {
      lastCelebrate.current = celebrateTick;
      const sprites = api();
      const dur = sprites?.STATE_DEFS?.laugh?.duration ?? 1.7;
      want.current.laughUntil = performance.now() / 1000 - originRef.current + dur;
    }
  }, [celebrateTick]);

  return (
    <div className="moshi-host" data-testid="v3-moshi-face" data-live={api() ? true : undefined} aria-hidden="true">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} data-testid="v3-moshi-canvas" />
    </div>
  );
}
