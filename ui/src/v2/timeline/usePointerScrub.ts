import { useEffect, useRef } from "react";

const EPSILON = 1e-6;

const capturePointer = (element: HTMLElement, pointerId: number) => {
  try {
    element.setPointerCapture(pointerId);
  } catch {}
};

const releasePointer = (element: HTMLElement, pointerId: number) => {
  try {
    element.releasePointerCapture(pointerId);
  } catch {}
};

export function usePointerScrub(onScrub: (position: number) => void) {
  const onScrubRef = useRef(onScrub);
  const activePointer = useRef<number | null>(null);
  const activeElement = useRef<HTMLElement | null>(null);
  const startPosition = useRef(0);
  const moved = useRef(false);
  const pendingPosition = useRef<number | null>(null);
  const pendingFrame = useRef<number | null>(null);
  onScrubRef.current = onScrub;

  const cancelPending = () => {
    if (pendingFrame.current != null) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = null;
    pendingPosition.current = null;
  };

  const cancel = (element: HTMLElement, pointerId: number) => {
    if (activePointer.current !== pointerId) return false;
    cancelPending();
    activePointer.current = null;
    activeElement.current = null;
    moved.current = false;
    releasePointer(element, pointerId);
    return true;
  };

  const begin = (element: HTMLElement, pointerId: number, position: number) => {
    if (activePointer.current != null && activeElement.current)
      releasePointer(activeElement.current, activePointer.current);
    cancelPending();
    activePointer.current = pointerId;
    activeElement.current = element;
    startPosition.current = position;
    moved.current = false;
    capturePointer(element, pointerId);
    onScrubRef.current(position);
  };

  const move = (pointerId: number, position: number) => {
    if (activePointer.current !== pointerId) return false;
    if (Math.abs(position - startPosition.current) > EPSILON) moved.current = true;
    if (!moved.current) return true;

    pendingPosition.current = position;
    if (pendingFrame.current == null) {
      pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = null;
        const pending = pendingPosition.current;
        pendingPosition.current = null;
        if (pending != null && activePointer.current === pointerId)
          onScrubRef.current(pending);
      });
    }
    return true;
  };

  const end = (element: HTMLElement, pointerId: number, position: number) => {
    if (activePointer.current !== pointerId) return false;
    const shouldCommit = moved.current || Math.abs(position - startPosition.current) > EPSILON;
    cancelPending();
    activePointer.current = null;
    activeElement.current = null;
    moved.current = false;
    releasePointer(element, pointerId);
    if (shouldCommit) onScrubRef.current(position);
    return true;
  };

  useEffect(() => () => {
    cancelPending();
    if (activePointer.current != null && activeElement.current)
      releasePointer(activeElement.current, activePointer.current);
    activePointer.current = null;
    activeElement.current = null;
  }, []);

  return { begin, move, end, cancel };
}
