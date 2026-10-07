import { useCallback, useEffect, useRef, useState } from "react";
import { newGestureId } from "./gesture";

const raf: (cb: () => void) => number =
  typeof requestAnimationFrame === "function" ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelRaf: (h: number) => void =
  typeof cancelAnimationFrame === "function" ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h);

/** How long the optimistic value stays on screen after a drag ends, while the engine's
 *  track patch (which carries the real value) arrives. */
export const SETTLE_MS = 300;

/** Drag plumbing shared by every panel control.
 *
 *  - `live` is the value being dragged (show it instead of the snapshot's while set), so
 *    the control follows the pointer without waiting for a round trip;
 *  - `update` sends at most once per animation frame, always with the drag's gesture id,
 *    so a whole drag is ONE undo step in the engine;
 *  - `end` sends the last value at once and keeps `live` for SETTLE_MS;
 *  - `nudge` is for keys and the wheel: a burst of nudges within 600 ms shares one gesture
 *    (one undo step per burst, not per key repeat). */
export function useDragSend<T>(send: (value: T, gesture: string) => void) {
  const [live, setLive] = useState<T | null>(null);
  const gesture = useRef<string | null>(null);
  const pending = useRef<{ v: T } | null>(null);
  const frame = useRef<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burst = useRef<{ id: string; at: number } | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  const flush = useCallback(() => {
    frame.current = null;
    const p = pending.current;
    pending.current = null;
    if (p && gesture.current) sendRef.current(p.v, gesture.current);
  }, []);

  const begin = useCallback(() => {
    if (settle.current) { clearTimeout(settle.current); settle.current = null; }
    gesture.current = newGestureId();
  }, []);

  const update = useCallback((v: T) => {
    if (!gesture.current) gesture.current = newGestureId();
    setLive(v);
    pending.current = { v };
    if (frame.current === null) frame.current = raf(flush);
  }, [flush]);

  const end = useCallback(() => {
    if (frame.current !== null) { cancelRaf(frame.current); frame.current = null; }
    flush();
    gesture.current = null;
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => { settle.current = null; setLive(null); }, SETTLE_MS);
  }, [flush]);

  const nudge = useCallback((v: T) => {
    const now = Date.now();
    if (!burst.current || now - burst.current.at > 600) burst.current = { id: newGestureId(), at: now };
    burst.current.at = now;
    sendRef.current(v, burst.current.id);
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelRaf(frame.current);
    if (settle.current) clearTimeout(settle.current);
  }, []);

  return { live, begin, update, end, nudge };
}
