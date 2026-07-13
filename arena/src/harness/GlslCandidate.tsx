import { useEffect, useRef, useState } from "react";
import { createGlslRenderer, type GlslRenderer } from "./glslRenderer";
import { lintShader } from "./sandbox";
import { transport } from "./transport";
import { buildFixture } from "../kit/fixtures";
import type { Params } from "../reference/params";

const SLOW_MS = 40; // a preview frame budget; over this and we flag + throttle

// Renders a GLSL waveform candidate in an isolated WebGL2 context, lint-gated and
// compile-guarded (a bad shader shows an error, never crashes the app), driven by the
// shared transport + fixture.
//
// The canvas is created IMPERATIVELY per effect-run (not a JSX <canvas ref>). React
// StrictMode double-invokes effects; if the canvas were reused, the 2nd run's
// getContext() would hand back the 1st run's disposed (lost) context and compilation
// would fail. A fresh <canvas> each run guarantees a fresh, valid context, and cleanup
// disposes + removes it so contexts never leak toward the ~16 limit.
export function GlslCandidate({
  frag,
  params,
  mode,
  live,
  onFlag,
}: {
  frag: string;
  params: Params;
  mode: 0 | 1 | 2;
  live: boolean;
  onFlag?: (reason: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (!live) return;
    const host = mountRef.current;
    if (!host) return;

    const lint = lintShader(frag);
    if (!lint.ok) {
      setError(lint.reason || "rejected");
      onFlag?.(lint.reason || "rejected");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block";
    host.appendChild(canvas);

    const { renderer, error: compileErr } = createGlslRenderer(canvas, frag, paramsRef.current);
    if (compileErr || !renderer) {
      setError(compileErr || "compile failed");
      onFlag?.(compileErr || "compile failed");
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      return;
    }
    setError(null);
    const r: GlslRenderer = renderer;
    r.setFixture(buildFixture(mode));

    let slow = false;
    let frameToggle = false;
    const onLost = (e: Event) => e.preventDefault();
    canvas.addEventListener("webglcontextlost", onLost, false);

    const unsub = transport.subscribe((s) => {
      if (slow) {
        frameToggle = !frameToggle;
        if (frameToggle) return; // once flagged slow, render every other frame
      }
      r.setParams(paramsRef.current);
      const ms = r.render(s.time, s.playhead, s.playing);
      if (!slow && ms > SLOW_MS) {
        slow = true;
        onFlag?.(`slow (~${ms.toFixed(0)}ms/frame)`);
      }
    });

    return () => {
      unsub();
      canvas.removeEventListener("webglcontextlost", onLost);
      r.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, frag, mode]);

  if (!live) return <div className="cand-poster" aria-hidden />;
  return (
    <>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      {error && (
        <div className="glsl-error" role="alert">
          <b>shader rejected</b>
          <span>{error}</span>
        </div>
      )}
    </>
  );
}
